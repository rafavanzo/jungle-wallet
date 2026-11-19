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
