# Arquitetura

Registro das decisões técnicas do `jungle-wallet`, com contexto e trade-offs.

## Decisões

### ADR-001: MiniStack em vez de LocalStack para emular o SQS

**Contexto**

O desafio pede AWS SQS emulado localmente "via LocalStack ou MiniStack", e os
testes de integração precisam rodar contra o emulador real em container. Quem
avalia o projeto precisa conseguir subir tudo com `docker compose up`, sem
credenciais nem cadastro.

Desde 23 de março de 2026 (versão 2026.03.0), a imagem `localstack/localstack`
é distribuída como imagem única e exige um auth token (`LOCALSTACK_AUTH_TOKEN`)
vinculado a uma conta LocalStack para iniciar. A edição Community sem conta
deixou de existir como imagem separada. A alternativa sugerida pelo próprio
LocalStack, fixar uma versão antiga da imagem Community, não recebe mais
correções.

**Decisão**

Usar o MiniStack (`ministackorg/ministack`), emulador AWS gratuito e de código
aberto, que não exige conta nem token e expõe a mesma porta (4566) e a mesma API
do LocalStack. A imagem é fixada numa versão exata (`1.5.42`) para que o
ambiente do avaliador seja igual ao de desenvolvimento.

**Consequências**

- Ganho: o projeto sobe em qualquer máquina com Docker, sem segredos pessoais
  no repositório nem passos manuais de cadastro.
- Custo: o MiniStack é mais novo e menos maduro que o LocalStack, com risco de
  fidelidade menor à AWS em recursos menos usados.

**Mitigação**

- Só usamos recursos básicos do SQS: filas FIFO, `MessageGroupId`,
  `MessageDeduplicationId`, visibility timeout e redrive para DLQ.
- O comportamento crítico foi verificado na versão fixada: após 5 recebimentos
  sem `DeleteMessage`, a mensagem sai de `wager-transactions.fifo` e vai para
  `wager-transactions-dlq.fifo` (`maxReceiveCount=5`).
- As filas são criadas com o `aws-cli` oficial (`infra/sqs/init-queues.sh`), o
  mesmo script que rodaria contra a AWS real.
- Os nomes das filas são fixos no script de init da infraestrutura
  (`init-queues.sh`). A aplicação os lê do `.env` (`SQS_WAGER_QUEUE_NAME`,
  `SQS_WAGER_DLQ_NAME`) e resolve a URL via `GetQueueUrl`, porque o formato da
  URL muda entre emuladores e a AWS real. Trocar para LocalStack ou AWS real é
  só mudar a imagem e o endpoint.

**Referências**

- [The Road Ahead for LocalStack](https://blog.localstack.cloud/the-road-ahead-for-localstack/)
- [LocalStack for AWS 2026.03.0 Release](https://blog.localstack.cloud/localstack-for-aws-release-2026-03-0/)
- [MiniStack: migração a partir do LocalStack](https://www.ministack.org/docs/migrating-from-localstack)

### ADR-002: Money representado como bigint em centavos

**Contexto**

Dinheiro não pode passar por `number`, `float` ou `double`. A escala é fixa em
2 casas e entradas com mais de 2 casas são rejeitadas, então o domínio nunca
precisa arredondar.

**Opções**

- Biblioteca decimal (`decimal.js`, `big.js`): precisão arbitrária e qualquer
  escala, ao custo de uma dependência e de configurar o arredondamento para
  garantir que ele nunca aconteça.
- `bigint` em centavos (`"25.00"` vira `2500n`): aritmética inteira, nativa do
  JavaScript, sem dependência e sem arredondamento possível.

**Decisão**

`bigint` em centavos. O valor é convertido direto do texto para `bigint`
(parte inteira × 100 + parte decimal) e nunca passa por `number`. O `Money` é
imutável: toda operação devolve uma nova instância, então valores como o
"saldo antes" gravado no ledger não mudam depois de calculados.

**Consequências**

- A escala de 2 casas é fixa para todas as moedas. Moedas com outra escala
  (JPY tem 0 casas, BHD tem 3) estão fora do escopo. O modelo comporta essa
  extensão com um mapa `moeda → escala`, usado na conversão e na formatação.
- O `Money` aceita negativos internamente (`subtract`, `negate`). Impedir saldo
  negativo é regra da `Wallet` e do `CHECK` no banco, não do `Money`.
- O limite de `NUMERIC(20,2)` também vale para o resultado das operações, em
  valor absoluto. Um `add` que estoura lança `AMOUNT_OUT_OF_RANGE` no domínio,
  em vez de virar um erro 500 no `INSERT`, que um provedor trataria como falha
  temporária e reenviaria para sempre.
- Moedas diferentes: `equals` retorna `false`, enquanto `add`, `subtract` e
  `isLessThan` lançam `CURRENCY_MISMATCH`. É intencional: "R$ 25 é igual a
  US$ 25?" tem resposta (não), mas "R$ 1 é menor que US$ 1?" não tem resposta
  sem uma taxa de câmbio, e o domínio não faz conversão.

### ADR-003: formato de entrada de valores monetários

**Decisão**

`Money.from` aceita uma string com parte inteira e de 0 a 2 casas decimais
(`/^\d+(\.\d{1,2})?$/`) e normaliza a saída para sempre 2 casas: `"25"` e
`"25.5"` viram `"25.00"` e `"25.50"`. É tolerante na entrada e estrito na saída.

São rejeitados com `INVALID_MONEY`:

- string vazia, `NaN`, `Infinity`, notação científica (`1e3`), hexadecimal;
- mais de 2 casas decimais (`10.123`);
- sinal, positivo ou negativo (`-5.00`, `+10`);
- formatos não canônicos: espaços, vírgula decimal (`10,00`), `10.` e `.5`;
- valores acima do que cabe em `NUMERIC(20,2)` (999999999999999999.99), para
  que o erro aconteça no domínio e não como overflow no `INSERT`;
- qualquer valor que não seja string, como um `number` vindo de um JSON
  (`{"amount": 25.5}`). Sem essa checagem a regex converteria o número para
  texto e o aceitaria.

A moeda precisa ser um código ISO-4217 em maiúsculas (`/^[A-Z]{3}$/`).

**Consequências**

- Zeros à esquerda são aceitos e normalizados (`"007.50"` vira `"7.50"`).
- Valores equivalentes como `"25"` e `"25.00"` representam o mesmo dinheiro.
  O `payloadHash` de idempotência deve ser calculado sobre o valor normalizado,
  senão a mesma aposta geraria hashes diferentes.

### ADR-004: máquina de estados da WagerTransaction e retry de referência

**Transições válidas**

```
PENDING ─────────┬─► PROCESSED
                 ├─► REJECTED
                 ├─► FAILED
                 └─► PENDING_REFERENCE ─┬─► PROCESSED
                       │      ▲         ├─► REJECTED
                       └──────┘         └─► FAILED
                  (nova tentativa)
```

- `PROCESSED`, `REJECTED` e `FAILED` são terminais. Qualquer transição a partir
  deles lança `InvalidTransactionStateError`: é erro de programação, não caminho
  de negócio, e por isso não tem `failureCode` para o provedor.
- `OPENING` é interno e nasce `PROCESSED` por uma factory própria
  (`WagerTransaction.opening`). O `create`, usado para tudo que vem de
  provedores, rejeita `OPENING`, então é estruturalmente impossível submetê-lo
  pela API ou pela fila.

**Referência fora de ordem (seção 7.1)**

Quando a referência ainda não existe, a transação vai para `PENDING_REFERENCE`
e é tentada de novo com backoff exponencial: `min(1s × 2^(tentativa − 1), 5min)`,
ou seja 1s, 2s, 4s, ..., 256s e depois 5min. O limite é de 10 tentativas, cerca
de 13 minutos no total. Esgotado o limite, a transação é rejeitada com
`REFERENCE_NOT_FOUND`.

Justificativa do limite: na prática os provedores enviam a operação
referenciada em segundos. Se em 13 minutos ela não chegou, é muito provável que
não chegue, e manter a transação pendente por mais tempo só esconde o problema.
O limite e os intervalos são constantes (`MAX_REFERENCE_ATTEMPTS`,
`REFERENCE_RETRY_*`), fáceis de ajustar.

Uma referência que existe mas ainda está `PENDING` ou `PENDING_REFERENCE` conta
como ausente: a transação que depende dela também fica pendente.

### ADR-005: cada transação pode ser revertida no máximo uma vez

**Contexto**

A regra 4 diz que uma referência não pode ser revertida duas vezes pelo mesmo
tipo de operação. Numa leitura literal, dois tipos diferentes podem reverter a
mesma transação:

| Operação                  | Saldo  |
| ------------------------- | ------ |
| saldo inicial             | 100.00 |
| BET de 10.00              | 90.00  |
| REFUND do BET (+10.00)    | 100.00 |
| ROLLBACK do BET (+10.00)  | 110.00 |

O jogador termina com 10.00 a mais do que tinha: um crédito duplicado.

**Decisão**

Cada transação pode ser revertida no máximo uma vez, por qualquer tipo de
reversão (`REFUND` ou `ROLLBACK`). A segunda reversão é rejeitada com
`REFERENCE_ALREADY_REVERSED`. É mais estrito que a regra 4, então a satisfaz, e
elimina o crédito duplicado.

O encadeamento legítimo continua funcionando: BET, depois REFUND do BET, depois
ROLLBACK do REFUND. Cada transação é revertida uma vez só.

**Onde a garantia mora**

Não no domínio: duas instâncias podem processar as duas reversões ao mesmo
tempo, e só o banco resolve essa corrida. A garantia é um índice único parcial
sobre a referência para os kinds `REFUND` e `ROLLBACK`.

### ADR-006: interpretações das regras de transação

A seção 7 pede que interpretações adicionais sejam documentadas.

- **LOSS aceita `0.00`.** Provedores costumam mandar o valor do prêmio, que numa
  derrota é zero. LOSS não altera o saldo. Todos os outros kinds exigem valor
  positivo (`INVALID_AMOUNT`).
- **Referência por kind.** BET não aceita referência. WIN e LOSS podem
  referenciar um BET. REFUND exige e só aceita um BET. ROLLBACK exige e aceita
  BET, WIN ou REFUND. Uma transação não pode referenciar a si mesma.
- **Regra 5 (valor igual ao da referência) vale só para reversões.** REFUND e
  ROLLBACK devolvem exatamente o valor original. Um WIN referenciando um BET
  tem, por natureza, um valor diferente da aposta.
- **Direção do ledger.** OPENING, WIN e REFUND creditam; BET debita; LOSS não
  gera lançamento; ROLLBACK é o inverso da referência (de BET credita, de WIN ou
  REFUND debita).
- **Ordem das checagens de referência.** Primeiro os erros de payload (kind,
  campos da regra 2, valor), depois o estado da referência. Um payload errado é
  sempre reportado como tal, independentemente do estado da referência.
- **Saldo resultante na transação.** `PROCESSED` e `REJECTED` guardam o saldo
  observado ao finalizar. O replay idempotente (regra 7) devolve esse valor sem
  consultar o ledger, inclusive para LOSS e rejeições, que não têm lançamento.
  É um retrato histórico, não um saldo vivo, então não diverge do ledger.
- **Rejeição persistida × erro de formato.** Os `failureCode`s (`FailureCode`)
  são rejeições de negócio: a transação é persistida como `REJECTED` e fica
  auditável. Erros de formato (`INVALID_MONEY`, `INVALID_AMOUNT`, referência
  ausente num REFUND, `RESERVED_PROVIDER_ID`) não geram transação: são um 400
  direto.
- **`providerId` `internal` é reservado.** A transação OPENING usa esse
  provedor e a chave `opening:<walletId>`. Um provedor externo que envie
  `providerId: "internal"` é rejeitado no `create`, para não colidir com o
  namespace interno.

### ADR-007: Wallet como agregado que produz o próprio ledger

- **Saldo só muda por `debit` e `credit`**, e ambos devolvem o lançamento já
  calculado. Não existe `setBalance`: é impossível mudar o saldo sem gerar o
  lançamento.
- **Ids e datas vêm de fora.** O domínio não gera UUID nem lê o relógio, o que
  deixa os testes determinísticos. Ids são UUID v7, ordenáveis por tempo.
- **Ledger com direção e valor positivo.** `balanceAfter = balanceBefore ∓ money`
  conforme `DEBIT`/`CREDIT`.
- **Falha não altera estado.** Tudo é validado e o lançamento é criado antes de
  tocar em saldo, `version` e `updatedAt`.
- **`INSUFFICIENT_FUNDS` é genérico.** A Wallet não conhece kinds; o caso de uso
  traduz para `REVERSAL_INSUFFICIENT_FUNDS` quando a operação é um ROLLBACK.
- **`version` começa em 1** e só incrementa quando o saldo muda. O saldo
  inicial entra no `open`, sem incrementar a `version`.
- **Concorrência não é papel do agregado.** Ele garante a consistência de uma
  operação; o lock no banco garante a serialização entre processos.

### ADR-008: invariantes no schema, com migration escrita à mão

- **A migration é a fonte da verdade do schema**, não as entidades. Ela é
  escrita em SQL (`this.addSql`), porque trigger, índice único parcial e CHECK
  composto não saem de um gerador. O `down()` desfaz tudo.
- **Migrations sem o CLI do MikroORM.** `src/infra/database/migrate.ts` chama o
  migrator direto (`bun run db:migrate` / `db:rollback`). O Bun executa
  TypeScript, então as migrations são carregadas da pasta sem nenhum loader.
  Cada uma roda numa transação, e o lote é tudo-ou-nada.
- **O que o banco garante, mesmo contornando o domínio:**
  - saldo nunca negativo (`CHECK balance >= 0`);
  - ledger append-only (triggers em UPDATE, DELETE e TRUNCATE) e com a
    aritmética conferida (`CHECK` igual ao `isBalanced()`);
  - um lançamento por transação (`UNIQUE (transaction_id, wallet_id)`);
  - moeda e wallet consistentes por FKs compostas: lançamento e saldo
    resultante da transação na moeda da wallet, lançamento na mesma wallet da
    transação, referência resolvida na mesma wallet (uma transação rejeitada por
    CURRENCY_MISMATCH pode estar em outra moeda; ver ADR-011);
  - uma única reversão por transação (índice único parcial), e uma transação
    processada com referência sempre tem o id interno resolvido, senão o `NULL`
    escaparia do índice;
  - idempotência por `(provider_id, idempotency_key)`: cada provedor tem o
    próprio espaço de chaves, e um não recebe o replay do outro;
  - estados terminais imutáveis (trigger) e coerentes (`failure_code` só em
    rejeição/falha, `processed_at` só em estado terminal).
- **Banco de teste separado** (`jungle_wallet_test`), porque o teste de
  reversibilidade roda o `down()`. Os testes não apagam dados (o ledger não
  permite); cada teste usa ids novos.
- **Postgres exposto na porta 5433** do host, para não colidir com um
  PostgreSQL instalado localmente na 5432.

### ADR-009: persistência e estratégia transacional

- **Portas na aplicação, MikroORM só na infraestrutura.** Os casos de uso falam
  com `UnitOfWork` e repositórios; trocar o ORM mexe só em `src/infra/`.
- **`UnitOfWork.run`** = `em.fork()` + `em.transactional()` em READ COMMITTED,
  com `SET LOCAL lock_timeout`. Os repositórios só existem dentro do `run`.
  READ COMMITTED porque, depois de esperar o lock da wallet, cada comando vê o
  que a outra execução acabou de commitar; o lock já serializa.
- **Comandos explícitos, sem change tracking.** Cada insert/update roda na hora,
  na ordem do caso de uso (o lançamento tem FK para a transação). Leituras usam
  `disableIdentityMap`, então o `flush` do commit não grava nada por conta
  própria. Do MikroORM usamos a fronteira transacional e o `LockMode`.
- **Updates com guarda:** wallet por `version`, transação pelo status anterior.
  Zero linhas afetadas vira `StaleUpdateError`.
- **Money no banco:** `NUMERIC(20,2)` + moeda em coluna própria; o driver devolve
  string e o mapper reconstrói com `Money.from`. Registros (`EntitySchema`, sem
  decorators) ficam separados das classes de domínio.
- **Erros do banco traduzidos num lugar só:** `23505` vira `UniqueViolationError`
  (com a constraint); lock timeout, deadlock, serialização e conexão viram
  `TransientInfrastructureError`; o resto sobe como bug.

### ADR-010: eventos, outbox, inbox e payloadHash

- **Eventos:** `IntegrationEvent` abstrato, uma subclasse por evento, com
  `eventType` e `version` fixados no tipo. O `data` só tem valores JSON (Money
  como `{ amount, currency }`) e é congelado. Todo evento leva o `walletId`, que
  vai ser o `MessageGroupId` no SQS.
- **`WagerTransactionPendingReference` sai só na entrada em
  `PENDING_REFERENCE`.** As novas tentativas do worker não publicam de novo; o
  desfecho sai como `Processed` ou `Rejected`.
- **Outbox sem limite de tentativas** (backoff de 2s até 5min). Um evento na
  outbox já é um fato commitado; desistir seria perdê-lo. Falha prolongada é
  problema de infraestrutura, visível pela métrica de outbox lag. Contraste com
  o `PENDING_REFERENCE`, que tem limite porque ali a espera pode nunca acabar.
- **Inbox com `INSERT ... ON CONFLICT DO NOTHING`**: a duplicata é resolvida no
  banco de forma atômica. Uma segunda instância com a mesma mensagem espera o
  commit da primeira e recebe "já existe".

**Algoritmo do `payloadHash` (v1)**

1. Entram só os campos de negócio: `providerId`, `externalTransactionId`,
   `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e
   `referenceExternalTransactionId`. Ficam de fora `idempotencyKey`,
   `messageId`, headers e qualquer metadado de transporte.
2. Normalização: `amount` passa por `Money.from(...).toString()` (`"25"` e
   `"25.00"` dão o mesmo hash); referência ausente, `null` ou `undefined` é
   omitida.
3. JSON canônico: chaves ordenadas recursivamente (por código de caractere, não
   pela localidade), sem espaços e sem `undefined`.
4. SHA-256 em hexadecimal, gravado como `sha256-v1:<hex>`. O prefixo identifica
   a versão do algoritmo caso ele mude.

Os campos são os mesmos no HTTP e no SQS: a mesma operação enviada pelas duas
portas vira replay, não conflito.

### ADR-011: casos de uso OpenWallet e SubmitWagerTransaction

- **Resultado explícito, não exceção.** Rejeição de negócio é um resultado
  persistido (`status`, `failureCode`, `balance`). Exceções só para o que impede
  o processamento: payload inválido, wallet inexistente, conflito de
  idempotência e falha transitória. O caso de uso não conhece HTTP nem SQS.
- **Lock antes da idempotência.** Requisições iguais fazem fila na linha da
  wallet; a primeira processa, as seguintes veem o commit e viram replay. Em
  READ COMMITTED cada comando vê o que já foi commitado depois do lock.
- **Nova tentativa única (F5)** quando uma violação de unicidade indica que
  outra execução commitou primeiro (idempotência, id externo, reversão única).
  Uma segunda violação seguida é tratada como anomalia (500).
- **Replay de transação pendente** devolve o status atual, sem saldo: para o
  provedor, o útil é saber o estado de agora.
- **CURRENCY_MISMATCH é persistido.** Para isso a transação tem FK simples para
  a wallet (migration `rejected_currency_mismatch`); o ledger continua com a FK
  composta, então nenhum lançamento em outra moeda é possível. O saldo resultante
  tem moeda própria, sempre a da wallet (FK composta).
- **Invariante dos testes:** saldo da wallet = soma dos lançamentos, e
  `version = 1 + movimentos depois da abertura`.

### ADR-012: API HTTP e mapeamento de status

O status HTTP sozinho responde "posso reenviar?": com 503 sim, com todo o resto
não. O mesmo mapa vale para todos os endpoints.

| Status | Situação | Códigos | O que o provedor faz |
| ------ | -------- | ------- | -------------------- |
| 201 | criado ou processado agora | wallet criada; transação nova `PROCESSED` | nada |
| 200 | replay de transação processada; consultas | `idempotentReplay: true` | nada |
| 202 | aceito, processamento pendente | `PENDING_REFERENCE` (novo ou replay) | aguarda, consulta pelo GET |
| 400 | payload inválido | `VALIDATION_ERROR`, `INVALID_MONEY`, `INVALID_AMOUNT`, `MISSING_REFERENCE`, `UNEXPECTED_REFERENCE`, `SELF_REFERENCE`, `UNSUPPORTED_TRANSACTION_KIND`, `RESERVED_PROVIDER_ID`, `INVALID_PLAYER_ID`, `MISSING_IDEMPOTENCY_KEY`, `INVALID_CURSOR` | corrige e não reenvia igual |
| 404 | recurso inexistente | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND`, `ROUTE_NOT_FOUND` | corrige o id |
| 409 | conflito | `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_KEY_REUSED`, `EXTERNAL_TRANSACTION_ID_CONFLICT` | não reenvia com a mesma chave |
| 413 | corpo grande demais | `PAYLOAD_TOO_LARGE` | reduz o payload |
| 422 | rejeição de negócio persistida, ou `FAILED` | todos os `failureCode` | definitivo; não reenvia |
| 503 | falha transitória de infraestrutura | `TRANSIENT_INFRASTRUCTURE` (+ `Retry-After`) | reenvia com a mesma chave (idempotente) |
| 500 | bug | `INTERNAL_ERROR` e erros de programação do domínio | investigação |

- **422 e não 200 para rejeição:** um provedor que só olha o status não pode
  achar que a aposta passou. O corpo traz `status`, `failureCode` e `balance`.
  O replay de uma rejeição também é 422 (regra 7: o resultado original).
- **`FAILED` também é 422:** é um resultado definitivo. O corpo traz
  `status: "FAILED"`, o que o diferencia de uma rejeição de negócio.
- **Exaustividade em compilação:** `DomainError` e `ApplicationError` tipam o
  `code` com uma união de literais, e o mapa é um `Record<ErrorCode, number>`.
  Um código novo sem status não compila.
- **Corpo de erro:** `{ error: { code, message }, correlationId }`. Um 500 só
  diz "Erro interno"; stack e SQL vão para o log.
- **Validação com Zod** (`src/contracts/`), o mesmo schema para HTTP e SQS, sem
  conversão de tipos: um `amount` numérico é 400. **Campos desconhecidos são
  ignorados** (tolerant reader): um campo extra não quebra o provedor, e como o
  `payloadHash` só usa campos conhecidos, a idempotência não muda.
- **Ids de rota validados como UUID** antes do banco, para um erro do cliente
  não virar um 500 (`22P02`).
- **Cursor do ledger:** `base64url({ v: 1, afterId })`, opaco e estável (UUID v7
  ordenável, ledger só com inserts). Busca `limit + 1` para saber se há próxima
  página, sem COUNT.
- **Autenticação:** `ProviderAuthGuard` no-op como ponto de extensão (OIDC com
  Keycloak/Zitadel e conferência do `providerId`); não vale para os health checks.
- **`X-Correlation-Id` em toda resposta:** o middleware roda antes do parser de
  JSON, então até um JSON malformado ou uma rota inexistente devolvem o id. Um
  valor inválido é substituído por um gerado, com aviso no log: um header de
  rastreamento não impede uma aposta válida (tolerant reader).
- **Formatos diferentes de propósito:** nas respostas HTTP, campo ausente vem
  como `null` (formato estável para quem consome); nos eventos ele é omitido,
  para o envelope sobreviver a `JSON.stringify`/`JSON.parse` sem mudar.
