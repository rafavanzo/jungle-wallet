# jungle-wallet

Processador de transações de apostas (BET, WIN, LOSS, REFUND, ROLLBACK) sobre wallets.
Bun + NestJS + PostgreSQL + SQS (MiniStack). Cada movimento gera um lançamento num ledger
append-only, com idempotência persistente, outbox para os eventos e inbox para o consumidor.

## Pré-requisitos

- Bun 1.x
- Docker com Compose

## Como rodar

```bash
cp .env.example .env
bun install
docker compose up -d
docker compose ps -a      # postgres "healthy"; sqs-init "Exited (0)"
bun run db:migrate
bun run start
```

| Serviço  | Porta | Observação                                                  |
| -------- | ----- | ----------------------------------------------------------- |
| API      | 3000  | `PORT` no `.env`                                            |
| Postgres | 5433  | não 5432, para não conflitar com um Postgres local          |
| SQS      | 4566  | MiniStack; filas criadas pelo `sqs-init`                    |

O `sqs-init` cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e
`wagering-events.fifo`. O Postgres cria também o banco `jungle_wallet_test`, usado nos testes.

## Papéis (APP_ROLES)

| Papel      | O que liga                                                     |
| ---------- | -------------------------------------------------------------- |
| `api`      | servidor HTTP                                                  |
| `outbox`   | publisher da outbox para `wagering-events.fifo`                |
| `consumer` | consumidor de `wager-transactions.fifo`                        |
| `pending`  | worker que reprocessa transações em `PENDING_REFERENCE`        |

Padrão: todos. Papel desconhecido impede o processo de subir. Instâncias separadas:

```bash
APP_ROLES=api PORT=3000 bun run start
APP_ROLES=api PORT=3001 bun run start
APP_ROLES=outbox,consumer,pending bun run start   # sem porta HTTP
```

Mais de uma instância de cada papel é seguro: o lock da wallet serializa os movimentos e a
outbox usa `FOR UPDATE SKIP LOCKED`.

## Estrutura do projeto

```
src/
  domain/        regras de negócio: Money, Wallet, WagerTransaction, ledger, eventos
  application/   casos de uso, consultas e portas (interfaces de persistência e mensageria)
  contracts/     schemas Zod compartilhados pela API HTTP e pelo consumidor da fila
  infra/         MikroORM, migrations, SQS e métricas
  http/          controllers, mapa de status e filtro de erros
  workers/       publisher da outbox, consumidor SQS e worker de referências pendentes
test/
  integration/   schema, repositórios, casos de uso, outbox e consumidor
  e2e/           API HTTP, health, reconciliação e métricas
  concurrency/   corridas no mesmo saldo, lock por wallet e três processos
infra/           scripts de init do Postgres e das filas
```

Os testes de unidade ficam ao lado do código (`*.spec.ts` em `src/`).

## Testes

Os testes de integração, e2e e concorrência precisam de `docker compose up -d` e do `.env`;
os de unidade rodam sem nada. As migrations são aplicadas pelos próprios testes no banco
`jungle_wallet_test`.

| Comando                    | O que cobre                                       | Precisa     | Duração |
| -------------------------- | ------------------------------------------------- | ----------- | ------- |
| `bun run test:unit`        | domínio, contratos, mapa de status, workers       | nada        | < 1 s   |
| `bun run test:integration` | schema, repositórios, casos de uso, outbox, consumidor | Postgres e SQS | ~25 s |
| `bun run test:e2e`         | API HTTP, health, reconciliação, métricas         | Postgres e SQS | ~2 s  |
| `bun run test:concurrency` | corridas no mesmo saldo, lock por wallet, 3 processos | Postgres | ~5 s   |
| `bun test`                 | tudo                                              | Postgres e SQS | ~30 s |

Também: `bun run typecheck` e `bun run lint`.

## Exemplos com curl

```bash
# Criar wallet (guarde id e playerId)
curl -s -X POST localhost:3000/wallets -H 'Content-Type: application/json' \
  -d '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'

WALLET_ID=<id>
PLAYER_ID=player-1

# BET: 201 PROCESSED
BET='{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"'$PLAYER_ID'",
"walletId":"'$WALLET_ID'","roundId":"round-1","gameId":"game-1","kind":"BET",
"money":{"amount":"25.00","currency":"BRL"}}'
curl -s -X POST localhost:3000/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: bet-1' -d "$BET"

# Replay com a mesma Idempotency-Key: 200, mesmo resultado, "idempotentReplay": true
curl -s -X POST localhost:3000/wagering/transactions -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: bet-1' -d "$BET"

# Consulta de transação (por id, ou por provider + id externo)
curl -s localhost:3000/wagering/transactions/<transactionId>
curl -s localhost:3000/providers/provider-a/wagering/transactions/tx-1

# Ledger paginado: passe o nextCursor da resposta para a próxima página
curl -s "localhost:3000/wallets/$WALLET_ID/ledger?limit=1"
curl -s "localhost:3000/wallets/$WALLET_ID/ledger?limit=1&cursor=<nextCursor>"

# Reconciliação: saldo gravado contra o ledger (nunca corrige)
curl -s -X POST localhost:3000/wallets/$WALLET_ID/reconciliation

# Health e métricas
curl -s localhost:3000/health/live
curl -s localhost:3000/health/ready     # 503 se Postgres ou SQS não responderem
curl -s localhost:3000/metrics
```

Status HTTP: 201 processada, 200 replay ou consulta, 202 referência pendente, 422 rejeição
de negócio (`failureCode` no corpo), 409 conflito de idempotência, 503 falha transitória
(reenviar com a mesma chave). Tabela completa em [ARCHITECTURE.md](ARCHITECTURE.md).

## Enviar uma mensagem para a fila

Com o papel `consumer` no ar, usando o aws-cli do container `sqs-init`:

```bash
docker compose run --rm --entrypoint aws sqs-init \
  --endpoint-url http://sqs:4566 sqs send-message \
  --queue-url http://sqs:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET_ID" \
  --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested",
"occurredAt":"2026-07-29T15:00:00.000Z","data":{"providerId":"provider-a",
"externalTransactionId":"tx-2","idempotencyKey":"key-2","playerId":"'$PLAYER_ID'",
"walletId":"'$WALLET_ID'","roundId":"round-1","gameId":"game-1","kind":"BET",
"money":{"amount":"10.00","currency":"BRL"}}}'
```

O log do processo mostra `"msg":"ack"` e o saldo cai 10.00. Payload inválido vai para
`wager-transactions-dlq.fifo`.

## Problemas comuns

- **Testes falham com banco `jungle_wallet_test` inexistente.** O script que cria o banco
  de teste só roda num volume vazio. Recrie: `docker compose down -v && docker compose up -d`.
- **Fila não encontrada depois de reiniciar o `sqs`.** O MiniStack guarda as filas em
  memória. Rode `docker compose up sqs-init` de novo.
- **Porta ocupada.** Troque `PORT` no `.env` (API) ou o lado esquerdo do mapeamento no
  `docker-compose.yml` (5433, 4566), ajustando as URLs do `.env`.

## Roteiro manual de falhas

Cenários sem teste automatizado de ponta a ponta.

1. **Processo morre depois do commit e antes do ack ou da publicação.** Envie uma mensagem e
   mate o processo (`kill -9`) logo depois do log da transação. Suba outra instância: a
   mensagem volta após o visibility timeout (30 s), a inbox detecta a duplicata e o saldo
   não muda de novo. Na outbox, eventos com `published_at` nulo são publicados pela nova
   instância (`SELECT count(*) FROM outbox_messages WHERE published_at IS NULL` vai a 0).
2. **SIGTERM no consumidor.** Com mensagens na fila, envie SIGTERM ao processo. Ele para de
   buscar, espera a mensagem em andamento por até 10 s e devolve as não processadas
   (visibilidade 0). Nenhuma mensagem se perde; nenhuma é processada duas vezes.
3. **Postgres fora do ar.** `docker compose stop postgres`: `/health/live` continua 200 e
   `/health/ready` responde 503 com `"postgres":"down"`. `docker compose start postgres`
   e o ready volta a 200.

## Arquitetura

Decisões, trade-offs e limitações em [ARCHITECTURE.md](ARCHITECTURE.md).
