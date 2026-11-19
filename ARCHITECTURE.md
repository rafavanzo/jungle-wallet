# Arquitetura

O `jungle-wallet` processa transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) enviadas
por provedores de jogos, por HTTP ou por fila. Cada transação altera o saldo de uma wallet e
gera um lançamento num ledger imutável. O sistema precisa continuar correto com mensagens
duplicadas, fora de ordem ou processadas ao mesmo tempo por várias instâncias.

Princípio que guia as decisões abaixo: o banco é a última linha de defesa. O domínio valida
cada operação, e o schema garante as invariantes mesmo que o código tenha um bug ou que duas
instâncias processem a mesma wallet ao mesmo tempo.

## Visão geral

```
HTTP ─┐                            ┌─► wallet, transação, ledger, inbox, outbox
      ├─► SubmitWagerTransaction ──┤   (uma única transação SQL)
SQS  ─┘   (mesmo caso de uso)      └─► commit
                                          │
                 publisher da outbox ◄────┘──► wagering-events.fifo
                 worker de referências pendentes
```

- **Camadas:** `domain` (regras, sem dependência de framework), `application` (casos de uso e
  portas), `infra` (MikroORM, SQS, métricas), `http` e `workers` (entradas).
- **Um app, vários papéis:** `APP_ROLES` liga `api`, `outbox`, `consumer` e `pending` em
  qualquer combinação. As instâncias não compartilham estado em memória; a coordenação é
  toda feita no PostgreSQL.
- **Stack:** Bun, TypeScript estrito, NestJS, PostgreSQL 17, MikroORM e SQS emulado com
  MiniStack. O MiniStack foi escolhido porque a imagem do LocalStack passou a exigir conta e
  auth token, e o ambiente local precisa subir só com `docker compose up`. As filas são
  criadas com o `aws-cli` oficial; trocar de emulador ou usar a AWS real é mudar a imagem e
  o endpoint.

## Dinheiro

- `Money` guarda o valor em centavos como `bigint`, convertido direto do texto. O valor nunca
  passa por `number`, então não existe erro de ponto flutuante.
- A escala é fixa em 2 casas e entradas com mais casas são rejeitadas, em vez de
  arredondadas. A entrada aceita de 0 a 2 casas e é normalizada (`"25"` vira `"25.00"`).
- Foi preferido `bigint` a uma biblioteca decimal por ser exato, nativo e sem configuração de
  arredondamento. O custo é a escala fixa: moedas com outra escala exigiriam um mapa
  moeda → escala.
- Valores que não são string são rejeitados: um `25.5` vindo de JSON já perdeu precisão no
  parse, antes de chegar ao domínio.
- No banco, `NUMERIC(20,2)` e a moeda em coluna própria. O driver devolve string, e o mapper
  reconstrói o valor com `Money.from`, passando pela mesma validação.
- O limite de `NUMERIC(20,2)` também é validado no domínio, para que um estouro seja um erro
  previsível e não uma falha no `INSERT`.

## Invariantes garantidas pelo banco

O schema é escrito à mão em SQL nas migrations, porque triggers, índices parciais e `CHECK`s
compostos não saem de um gerador. As migrations são a fonte da verdade do schema.

| Invariante | Mecanismo |
|---|---|
| Saldo nunca negativo | `CHECK (balance >= 0)` |
| Uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| Ledger imutável | triggers que bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| Lançamento aritmeticamente correto | `CHECK (balance_after = balance_before ± amount)` |
| No máximo um lançamento por transação | `UNIQUE (transaction_id, wallet_id)` |
| Lançamento na moeda e na wallet da transação | FKs compostas `(wallet_id, currency)` e `(transaction_id, wallet_id)` |
| Transação única por provedor | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Uma reversão por transação | índice único parcial em `reference_transaction_id` para `REFUND` e `ROLLBACK` processados |
| Estado terminal imutável | trigger em `wager_transactions` |
| Mensagem consumida uma vez | `PRIMARY KEY (consumer_name, message_id)` na inbox |

A tabela de transações tem FK simples para a wallet, sem a moeda, porque também guarda
rejeições como `CURRENCY_MISMATCH`, que por definição estão em outra moeda. O ledger só guarda
fatos aplicados e por isso pode ter todas as FKs compostas.

## Concorrência

A unidade de concorrência é a wallet.

- **Lock pessimista por wallet:** `SELECT ... FOR UPDATE` na linha da wallet, no início da
  transação. Como o lock é por linha, wallets diferentes são processadas em paralelo e não
  existe lock global.
- **Por que não optimistic locking:** a operação não só altera o saldo; ela valida a
  referência, grava o lançamento com o saldo antes e depois e grava a outbox, tudo sobre o
  mesmo saldo. Com o lock, isso é simples de garantir, e uma wallet muito disputada não gera
  uma sequência de retries. A `version` continua como guarda no `UPDATE`
  (`WHERE version = anterior`).
- **Idempotência checada depois do lock:** requisições iguais fazem fila na linha da wallet.
  A primeira processa; as seguintes enxergam o commit dela e viram replay.
- **READ COMMITTED de propósito:** depois de esperar o lock, cada comando vê o que a outra
  instância acabou de commitar. Em REPEATABLE READ, a segunda requisição não veria esse
  commit.
- **`lock_timeout` de 5 s:** uma espera longa vira um erro transitório (503 no HTTP, sem ack
  na fila), em vez de prender conexões.
- **Sem deadlock por ordem de locks:** cada operação toca uma única wallet, e o worker de
  pendências trava na mesma ordem do caso de uso.
- **Rede de segurança:** uma violação de unicidade que indica que outra execução commitou
  primeiro gera uma única nova tentativa do caso de uso. Na segunda vez, ele encontra o que
  já foi commitado e responde corretamente.

## Idempotência

- A chave de idempotência (header `Idempotency-Key`, ou `data.idempotencyKey` na fila) tem
  escopo por provedor: provedores diferentes não recebem o replay um do outro.
- Mesma chave e mesmo payload: o resultado original é devolvido, inclusive o saldo observado
  naquele momento. Esse saldo fica gravado na própria transação, porque LOSS e rejeições não
  têm lançamento no ledger.
- Mesma chave com payload diferente é conflito (409), nunca replay. O mesmo id externo com
  outra chave também.
- **`payloadHash` (v1):**
  1. campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`,
     `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`; a chave de
     idempotência e os metadados de transporte ficam de fora;
  2. `amount` normalizado (`"25"` e `"25.00"` geram o mesmo hash) e referência ausente
     omitida;
  3. JSON canônico, com as chaves ordenadas recursivamente;
  4. SHA-256 em hexadecimal, gravado como `sha256-v1:<hex>` para permitir evoluir o
     algoritmo.
- Os campos são os mesmos nas duas entradas, então a mesma operação enviada por HTTP e pela
  fila é tratada como replay.

## Regras de negócio

```
PENDING ─┬─► PROCESSED | REJECTED | FAILED              (terminais)
         └─► PENDING_REFERENCE ─┬─► PROCESSED | REJECTED | FAILED
                                └─► PENDING_REFERENCE    (nova tentativa)
```

- Transicionar um estado terminal é erro de programação, não um caminho de negócio.
- `OPENING`, o crédito de abertura da wallet, nasce `PROCESSED` por uma factory interna. A
  factory usada para operações de provedores rejeita esse kind, e o `providerId` `internal`
  é reservado.
- Direção no ledger: OPENING, WIN e REFUND creditam; BET debita; LOSS não gera lançamento;
  ROLLBACK inverte a direção da transação referenciada.
- REFUND exige um BET; ROLLBACK exige um BET, WIN ou REFUND. A referência precisa ser do
  mesmo provedor, player, wallet, moeda e rodada, e numa reversão o valor deve ser igual ao
  da referência.
- **Cada transação pode ser revertida uma única vez, por qualquer tipo de reversão.**
  Permitir um REFUND e também um ROLLBACK do mesmo BET de 10.00 levaria o saldo de 90.00
  para 110.00: um crédito duplicado. O encadeamento BET → REFUND → ROLLBACK do REFUND
  continua possível, porque cada transação é revertida uma vez só.
- LOSS aceita valor `0.00`; os demais kinds exigem valor positivo.
- Rejeições de negócio são persistidas como `REJECTED`, com um `failureCode` estável. Erros
  de formato não geram transação e são devolvidos como 400.

| `failureCode` | Situação | Ação esperada do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | aposta sem saldo | desistir |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão deixaria o saldo negativo | desistir; caso para a operação |
| `REFERENCE_NOT_FOUND` | referência não chegou dentro do limite de tentativas | corrigir ou desistir |
| `REFERENCE_MISMATCH` | referência de outro provedor, player, wallet, moeda ou rodada | corrigir o payload |
| `REFERENCE_INVALID_KIND` | tipo de referência não permitido para o kind | corrigir o payload |
| `REFERENCE_AMOUNT_MISMATCH` | valor da reversão diferente do original | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | referência rejeitada ou com falha | desistir |
| `REFERENCE_ALREADY_REVERSED` | segunda reversão | desistir |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | wallet de outro player | corrigir o payload |
| `AMOUNT_OUT_OF_RANGE` | crédito estouraria o limite | desistir |
| `PROCESSING_FAILED` | erro permanente de infraestrutura (`FAILED`) | investigar |

## Referências fora de ordem

- Uma transação cuja referência ainda não existe (ou ainda está pendente) fica
  `PENDING_REFERENCE`, e o evento `WagerTransactionPendingReference` é emitido uma vez.
- O worker `pending` a reprocessa com backoff exponencial (1 s, 2 s, 4 s... até 5 min), no
  máximo 10 vezes, cerca de 13 minutos no total. Depois disso, ela é rejeitada com
  `REFERENCE_NOT_FOUND`.
- O limite existe porque provedores costumam enviar a operação referenciada em segundos: se
  ela não chegou em 13 minutos, é improvável que chegue, e manter a pendência só esconderia
  o problema.
- O worker reutiliza a mesma lógica de decisão do caso de uso (`WagerTransactionProcessor`)
  e trava a wallet antes de recarregar a transação. Dois workers no mesmo item se
  serializam, e o segundo pula.

## Eventos e Transactional Outbox

- Eventos: `WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`
  (só quando o saldo muda) e `WagerTransactionPendingReference`. Cada um tem `eventType` e
  `version` fixos no tipo, e o `data` carrega dinheiro como string decimal.
- Os eventos são gravados na outbox na mesma transação da operação financeira; nada é
  publicado antes do commit.
- O publisher busca lotes com `FOR UPDATE SKIP LOCKED`, então vários publishers pegam lotes
  disjuntos sem esperar uns pelos outros.
- A publicação acontece com o lock segurado. Se o processo morre depois do commit, o lote é
  liberado e outra instância publica. A entrega é at-least-once: o `eventId` é estável e
  serve como `MessageDeduplicationId` e como chave de deduplicação para o consumidor.
- Trade-off: a transação fica aberta durante a chamada ao SQS. Isso é mitigado por lotes
  pequenos (10), timeout curto e o retry do SDK desligado, porque quem repete é a outbox.
- A outbox não tem limite de tentativas: um evento commitado é um fato e não pode ser
  perdido. Uma falha prolongada aparece na métrica `outbox_lag_seconds`.
- `MessageGroupId = walletId`, para manter a ordem por wallet até onde o FIFO permite.

## Consumo da fila

- O consumidor usa o mesmo caso de uso e o mesmo schema de validação da API HTTP.
- O primeiro passo da transação é gravar a inbox (`INSERT ... ON CONFLICT DO NOTHING`). Uma
  segunda instância com a mesma mensagem espera o commit da primeira e recebe "já existe".
  Inbox, saldo, ledger e outbox são confirmados ou desfeitos juntos.
- O ack só acontece depois do commit. Se o processo morre entre os dois, a mensagem volta e
  a inbox impede o efeito duplicado.
- Classificação de erros:
  - resultado de negócio (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`): ack;
  - erro transitório ou desconhecido: sem ack, com visibilidade em backoff
    (`min(2^recebimentos, 60)` s);
  - erro permanente (payload inválido, wallet inexistente, conflito de idempotência): DLQ
    imediatamente, com o motivo nos atributos;
  - limite de recebimentos atingido (`MAX_RECEIVE_COUNT`, padrão 5): DLQ.
- A decisão de mandar para a DLQ fica na aplicação; a `RedrivePolicy` da fila é uma rede de
  segurança, não a garantia.
- No SIGTERM, o consumidor para de buscar, espera a mensagem em andamento por até 10 s e
  devolve as não concluídas com `ChangeMessageVisibility(0)`.

## API HTTP

O status HTTP responde sozinho se o cliente pode reenviar: com 503, sim; com os demais, não.

| Status | Significado |
|---|---|
| 201 | wallet criada; transação nova processada |
| 200 | replay de transação processada; consultas |
| 202 | aceita, com processamento pendente (`PENDING_REFERENCE`) |
| 400 | payload inválido |
| 404 | wallet ou transação inexistente |
| 409 | wallet duplicada ou conflito de idempotência |
| 422 | rejeição de negócio persistida (inclusive no replay) |
| 503 | falha transitória de infraestrutura, com `Retry-After` |
| 500 | erro interno; o detalhe vai só para o log |

- O mapa de códigos para status é um `Record` sobre a união de todos os códigos de erro: um
  código novo sem status não compila.
- Rejeição de negócio é 422, e não 200 com `status: REJECTED`, para que um cliente que só
  olha o status não interprete a aposta como aceita.
- A validação usa Zod (`src/contracts`), sem conversão de tipos. Campos desconhecidos são
  ignorados; como o hash usa só os campos de negócio, a idempotência não é afetada.
- O cursor do ledger é opaco (`base64url`) e estável, porque o ledger só recebe inserts e os
  ids são UUID v7, ordenáveis por tempo.
- Toda resposta leva `X-Correlation-Id`; um valor inválido recebido é substituído, não
  recusado.

## Persistência

- MikroORM, usando `em.fork()` + `em.transactional()` como fronteira transacional e
  `LockMode` para o lock pessimista.
- Os registros de persistência (`EntitySchema`, sem decorators) são separados das classes de
  domínio, e os mappers usam as factories `rehydrate`. O domínio não importa nada de ORM nem
  de NestJS.
- As escritas são comandos explícitos, na ordem do caso de uso (a transação antes do
  lançamento, por causa da FK), sem change tracking. A ordem fica visível no código, em vez
  de calculada pelo flush.
- Erros do banco são traduzidos num único ponto: violação de unicidade carrega o nome da
  constraint; lock timeout, deadlock, serialização e falha de conexão viram erros
  transitórios.
- As migrations são versionadas e reversíveis (`bun run db:migrate` / `db:rollback`).
  Mudanças de schema entram como migrations novas, sem editar as já publicadas.

## Autenticação

Não implementada nesta versão. O ponto de extensão é o `ProviderAuthGuard` (no-op), aplicado
aos controllers de wallet e de wagering; os health checks ficam abertos. O desenho previsto:
um Identity Provider externo (Keycloak ou Zitadel) com client credentials por provedor, e o
guard validando o JWT (assinatura via JWKS, emissor e audiência) e conferindo que o
`providerId` do token é o mesmo do payload. Mensagens da fila são tratadas como canal
interno, mas o `providerId` delas passa pelas mesmas validações de domínio.

## Observabilidade

- Logs em JSON com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId`
  nos pontos principais, sem payloads financeiros completos.
- Métricas Prometheus em `GET /metrics`: transações por status e kind, duplicatas, lock
  timeouts, latência, retries e DLQ do consumidor, divergências de reconciliação e
  `outbox_lag_seconds`.
- `GET /health/live` não depende de nada; `GET /health/ready` verifica PostgreSQL e SQS.
- `POST /wallets/:id/reconciliation` compara o saldo gravado com o ledger, num snapshot
  REPEATABLE READ READ ONLY e com a soma feita em `NUMERIC`. Divergências nunca são
  corrigidas automaticamente: viram log de erro, métrica e `consistent: false`.

## Estratégia de testes

- Testes de integração, e2e e concorrência rodam contra PostgreSQL e MiniStack reais.
- Os testes concorrentes verificam invariantes (contagens, saldo final, ledger), nunca a
  ordem de chegada, para serem determinísticos.
- Ao final, os testes conferem que o saldo da wallet é igual ao reconstruído pelo ledger e
  que o `balanceBefore` de cada lançamento é o `balanceAfter` do anterior. Um lost update
  quebraria esse encadeamento.
- O multi-instância é testado com três processos separados da aplicação, para que a única
  coisa compartilhada seja o banco.
- Falhas são simuladas de verdade: um processo filho morto no meio da publicação da outbox,
  e mensagens processadas sem ack que voltam depois do visibility timeout.

## Limitações e próximos passos

- Não há teste automatizado para o reinício completo do serviço nem para o SIGTERM do
  consumidor; o README tem um roteiro manual.
- A ordem do ledger usa o id (UUID v7), que depende do relógio da máquina. Melhoria: gravar a
  `version` da wallet em cada lançamento, com `UNIQUE (wallet_id, wallet_version)`, o que
  também tornaria um lost update impossível no próprio banco.
- Eventos da mesma wallet podem sair fora de ordem entre lotes do publisher; consumidores
  devem se apoiar no `eventId` e no `walletVersion`.
- O `correlationId` original não é persistido, então eventos gerados pelo worker de
  pendências usam o id da transação como correlação.
- O `correlationId` não entra automaticamente em toda linha de log (faltaria
  `AsyncLocalStorage`).
- `/metrics` não tem autenticação, e não há teste de carga.