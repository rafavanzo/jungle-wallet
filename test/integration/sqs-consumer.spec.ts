import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import { NoopWageringMetrics } from '../../src/application/metrics/wagering-metrics.js';
import { TransientInfrastructureError } from '../../src/application/ports/persistence-errors.js';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work.js';
import { SubmitWagerTransactionUseCase } from '../../src/application/wagering/submit-wager-transaction.use-case.js';
import { OpenWalletUseCase } from '../../src/application/wallets/open-wallet.use-case.js';
import { MikroOrmUnitOfWork } from '../../src/infra/database/mikro-orm-unit-of-work.js';
import { createSqsClient, readSqsSettings } from '../../src/infra/messaging/sqs-event-publisher.js';
import {
  SqsWagerConsumer,
  WAGER_CONSUMER_NAME,
} from '../../src/infra/messaging/sqs-wager-consumer.js';
import { SystemClock } from '../../src/infra/system/system-clock.js';
import { UuidV7Generator } from '../../src/infra/system/uuid-v7-generator.js';
import { openTestDatabase, type TestDatabase } from './helpers/database.js';
import { assertLedgerConsistent } from './use-cases/helpers.js';

const TEST_TIMEOUT_MS = 30_000;
const suffix = Bun.randomUUIDv7().replaceAll('-', '').slice(-12);
const QUEUE = `test-wager-${suffix}.fifo`;
const DLQ = `test-wager-${suffix}-dlq.fifo`;

let db: TestDatabase;
let sqs: SQSClient;
let queueUrl: string;
let dlqUrl: string;
let realUow: UnitOfWork;
let openWallet: OpenWalletUseCase;

beforeAll(async () => {
  db = await openTestDatabase();
  sqs = createSqsClient(readSqsSettings(), 20_000);
  // Visibility timeout de 1 s: uma mensagem sem ack volta logo.
  const create = async (name: string) =>
    (
      await sqs.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: {
            FifoQueue: 'true',
            ContentBasedDeduplication: 'false',
            VisibilityTimeout: '1',
          },
        }),
      )
    ).QueueUrl!;
  queueUrl = await create(QUEUE);
  dlqUrl = await create(DLQ);
  realUow = new MikroOrmUnitOfWork(db.orm);
  openWallet = new OpenWalletUseCase(realUow, new SystemClock(), new UuidV7Generator());
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await Promise.allSettled([
    sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })),
    sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl })),
  ]);
  sqs.destroy();
  await db.close();
});

const unique = (prefix: string): string => `${prefix}-${Bun.randomUUIDv7()}`;

/** Falha com erro transitório nas primeiras `failures` execuções. */
class FlakyUnitOfWork implements UnitOfWork {
  calls = 0;
  constructor(private readonly failures: number) {}
  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    this.calls += 1;
    if (this.calls <= this.failures) {
      return Promise.reject(new TransientInfrastructureError('banco indisponível', false));
    }
    return realUow.run(work);
  }
}

function consumerWith(uow: UnitOfWork = realUow, maxReceiveCount = 5): SqsWagerConsumer {
  const submit = new SubmitWagerTransactionUseCase(
    uow,
    new SystemClock(),
    new UuidV7Generator(),
    new NoopWageringMetrics(),
  );
  return new SqsWagerConsumer(sqs, submit, {
    queueName: QUEUE,
    dlqName: DLQ,
    maxReceiveCount,
    waitTimeSeconds: 1,
    shutdownGraceMs: 2_000,
  });
}

/**
 * O abort do long poll é só do lado do cliente: o servidor ainda espera até
 * WaitTimeSeconds e pode "receber" uma mensagem do teste seguinte. Espera isso
 * passar para cada teste ver só os próprios recebimentos.
 */
async function stopConsumer(consumer: SqsWagerConsumer): Promise<void> {
  await consumer.stop();
  await Bun.sleep(1_200);
}

async function newWallet() {
  return openWallet.execute({
    playerId: unique('player'),
    initialBalance: { amount: '100.00', currency: 'BRL' },
    correlationId: unique('corr'),
  });
}

function wagerMessage(wallet: { id: string; playerId: string }, overrides: object = {}) {
  return {
    messageId: unique('msg'),
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-sqs',
      externalTransactionId: unique('ext'),
      idempotencyKey: unique('idem'),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
      ...overrides,
    },
  };
}

async function send(body: string, groupId: string): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      // Sempre diferente: o FIFO deixa passar duplicatas da mesma messageId.
      MessageDeduplicationId: Bun.randomUUIDv7(),
    }),
  );
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error('Condição não atingida a tempo');
}

async function queueIsEmpty(url: string = queueUrl): Promise<boolean> {
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: url,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Attributes.ApproximateNumberOfMessages === '0' &&
    Attributes.ApproximateNumberOfMessagesNotVisible === '0'
  );
}

async function transactionsFor(idempotencyKey: string) {
  return db.execute<{ id: string; status: string; wallet_id: string }[]>(
    'SELECT id, status, wallet_id FROM wager_transactions WHERE idempotency_key = ?',
    [idempotencyKey],
  );
}

async function debits(walletId: string): Promise<number> {
  const [row] = await db.execute<{ count: string }[]>(
    "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE wallet_id = ? AND direction = 'DEBIT'",
    [walletId],
  );
  return Number(row!.count);
}

async function inboxRows(messageId: string) {
  return db.execute<{ processed: boolean }[]>(
    'SELECT processed_at IS NOT NULL AS processed FROM inbox_messages WHERE consumer_name = ? AND message_id = ?',
    [WAGER_CONSUMER_NAME, messageId],
  );
}

async function receiveDlq() {
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: dlqUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      MessageAttributeNames: ['All'],
    }),
  );
  // Apaga o que recebeu: senão volta depois do visibility timeout e aparece no teste seguinte.
  for (const message of Messages) {
    await sqs.send(
      new DeleteMessageCommand({ QueueUrl: dlqUrl, ReceiptHandle: message.ReceiptHandle }),
    );
  }
  return Messages;
}

describe('Consumidor SQS (MiniStack e Postgres reais)', () => {
  it(
    'processa, dá ack depois do commit e atualiza o ledger',
    async () => {
      const wallet = await newWallet();
      const message = wagerMessage(wallet);
      const consumer = consumerWith();

      await send(JSON.stringify(message), wallet.id);
      consumer.start();
      try {
        await waitUntil(
          async () => (await transactionsFor(message.data.idempotencyKey)).length > 0,
        );
        await waitUntil(() => queueIsEmpty());
      } finally {
        await stopConsumer(consumer);
      }

      const [transaction] = await transactionsFor(message.data.idempotencyKey);
      expect(transaction!.status).toBe('PROCESSED');
      expect(await debits(wallet.id)).toBe(1);
      expect(await inboxRows(message.messageId)).toEqual([{ processed: true }]);
      await assertLedgerConsistent(db, wallet.id);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'mesma messageId 2x (e uma 3ª com outro corpo): um único efeito, a inbox detecta',
    async () => {
      const wallet = await newWallet();
      const message = wagerMessage(wallet);
      // Mesma messageId, outra idempotency key: sem a inbox, viraria uma segunda aposta.
      const sameIdOtherBody = {
        ...message,
        data: {
          ...message.data,
          idempotencyKey: unique('idem'),
          externalTransactionId: unique('ext'),
        },
      };
      const consumer = consumerWith();

      await send(JSON.stringify(message), wallet.id);
      await send(JSON.stringify(message), wallet.id);
      await send(JSON.stringify(sameIdOtherBody), wallet.id);
      consumer.start();
      try {
        await waitUntil(
          async () => (await transactionsFor(message.data.idempotencyKey)).length > 0,
        );
        await waitUntil(() => queueIsEmpty());
      } finally {
        await stopConsumer(consumer);
      }

      expect(await transactionsFor(message.data.idempotencyKey)).toHaveLength(1);
      expect(await transactionsFor(sameIdOtherBody.data.idempotencyKey)).toHaveLength(0);
      expect(await inboxRows(message.messageId)).toEqual([{ processed: true }]);
      expect(await debits(wallet.id)).toBe(1);
      await assertLedgerConsistent(db, wallet.id);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'morto depois do commit e antes do ack: a mensagem volta e não duplica o efeito',
    async () => {
      const wallet = await newWallet();
      const message = wagerMessage(wallet);
      await send(JSON.stringify(message), wallet.id);

      // Recebe e processa (commit), mas "morre" antes do DeleteMessage.
      const dying = consumerWith();
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          WaitTimeSeconds: 2,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
      );
      expect(Messages).toHaveLength(1);
      expect((await dying.process(Messages[0]!)).kind).toBe('ack');
      expect(await debits(wallet.id)).toBe(1);

      // Passado o visibility timeout (1 s), outra instância recebe de novo.
      const survivor = consumerWith();
      survivor.start();
      try {
        await waitUntil(() => queueIsEmpty());
      } finally {
        await stopConsumer(survivor);
      }

      expect(await transactionsFor(message.data.idempotencyKey)).toHaveLength(1);
      expect(await debits(wallet.id)).toBe(1);
      await assertLedgerConsistent(db, wallet.id);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'erro transitório: sem ack, a mensagem volta e é processada na 2ª tentativa',
    async () => {
      const wallet = await newWallet();
      const message = wagerMessage(wallet);
      const flaky = new FlakyUnitOfWork(1);
      const consumer = consumerWith(flaky);

      await send(JSON.stringify(message), wallet.id);
      consumer.start();
      try {
        await waitUntil(
          async () => (await transactionsFor(message.data.idempotencyKey)).length > 0,
        );
        await waitUntil(() => queueIsEmpty());
      } finally {
        await stopConsumer(consumer);
      }

      expect(flaky.calls).toBe(2);
      expect((await transactionsFor(message.data.idempotencyKey))[0]!.status).toBe('PROCESSED');
      expect(await debits(wallet.id)).toBe(1);
      await assertLedgerConsistent(db, wallet.id);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'payload inválido vai direto para a DLQ',
    async () => {
      const consumer = consumerWith();
      await send(JSON.stringify({ messageId: unique('msg'), type: 'Outro' }), 'group-invalid');

      consumer.start();
      let dlq: Awaited<ReturnType<typeof receiveDlq>> = [];
      try {
        await waitUntil(async () => (dlq = await receiveDlq()).length > 0);
      } finally {
        await stopConsumer(consumer);
      }

      expect(dlq).toHaveLength(1);
      expect(dlq[0]!.MessageAttributes?.failureCode?.StringValue).toBe('INVALID_PAYLOAD');
      expect(await queueIsEmpty()).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'limite de recebimentos atingido vai para a DLQ',
    async () => {
      const wallet = await newWallet();
      const message = wagerMessage(wallet);
      const alwaysFailing = new FlakyUnitOfWork(Number.POSITIVE_INFINITY);
      const consumer = consumerWith(alwaysFailing, 2);

      await send(JSON.stringify(message), wallet.id);
      consumer.start();
      let dlq: Awaited<ReturnType<typeof receiveDlq>> = [];
      try {
        await waitUntil(async () => (dlq = await receiveDlq()).length > 0);
      } finally {
        await stopConsumer(consumer);
      }

      expect(alwaysFailing.calls).toBe(2);
      expect(dlq[0]!.MessageAttributes?.failureCode?.StringValue).toBe(
        'TRANSIENT_RETRIES_EXHAUSTED',
      );
      expect(JSON.parse(dlq[0]!.Body!).messageId).toBe(message.messageId);
      expect(await transactionsFor(message.data.idempotencyKey)).toHaveLength(0);
      expect(await queueIsEmpty()).toBe(true);
      await assertLedgerConsistent(db, wallet.id);
    },
    TEST_TIMEOUT_MS,
  );
});
