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
- Endpoint, região e nomes das filas vêm de variáveis de ambiente. Trocar para
  LocalStack ou AWS real é só mudar a imagem e o endpoint.

**Referências**

- [The Road Ahead for LocalStack](https://blog.localstack.cloud/the-road-ahead-for-localstack/)
- [LocalStack for AWS 2026.03.0 Release](https://blog.localstack.cloud/localstack-for-aws-release-2026-03-0/)
- [MiniStack: migração a partir do LocalStack](https://www.ministack.org/docs/migrating-from-localstack)
