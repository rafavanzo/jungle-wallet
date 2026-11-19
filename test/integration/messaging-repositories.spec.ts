import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { InboxMessage } from '../../src/domain/messaging/inbox-message.js';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message.js';
import { Money } from '../../src/domain/shared/money.js';
import { WalletBalanceChanged } from '../../src/domain/wagering/events/wallet-balance-changed.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { MikroOrmUnitOfWork } from '../../src/infra/database/mikro-orm-unit-of-work.js';
import { openTestDatabase, type TestDatabase } from './helpers/database.js';

const AT = new Date('2026-11-19T10:00:00.000Z');

const newId = (): string => Bun.randomUUIDv7();

let db: TestDatabase;
let uow: UnitOfWork;

beforeAll(async () => {
  db = await openTestDatabase();
  uow = new MikroOrmUnitOfWork(db.orm);
});

afterAll(async () => {
  await db.close();
});

function balanceChangedMessage(): OutboxMessage {
  const { wallet } = Wallet.open({
    id: newId(),
    playerId: `player-${newId()}`,
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    openingTransactionId: newId(),
    openingEntryId: newId(),
    at: AT,
  });
  const entry = wallet.debit({
    money: Money.from({ amount: '12.34', currency: 'BRL' }),
    transactionId: newId(),
    entryId: newId(),
    at: AT,
  });
  const event = WalletBalanceChanged.from(wallet, entry, {
    eventId: newId(),
    correlationId: `corr-${newId()}`,
    occurredAt: AT,
  });
  return OutboxMessage.enqueue(event);
}

const inboxMessage = (messageId = `msg-${newId()}`): InboxMessage =>
  InboxMessage.receive({
    messageId,
    consumerName: 'wager-consumer',
    payloadHash: 'sha256-v1:abc',
    receivedAt: AT,
  });

describe('outbox e inbox (MikroORM + Postgres real)', () => {
  it('ida e volta da outbox preserva o envelope no jsonb', async () => {
    const message = balanceChangedMessage();

    await uow.run(({ outbox }) => outbox.insert(message));
    const loaded = await uow.run(({ outbox }) => outbox.findById(message.id));

    expect(loaded).toBeInstanceOf(OutboxMessage);
    expect(loaded?.payload).toEqual(message.payload);
    expect(loaded?.payload).toMatchObject({
      eventType: 'WalletBalanceChanged',
      data: { money: { amount: '12.34', currency: 'BRL' }, walletVersion: 2 },
    });
    expect(loaded?.eventType).toBe('WalletBalanceChanged');
    expect(loaded?.aggregateId).toBe(message.aggregateId);
    expect(loaded?.attempts).toBe(0);
    expect(loaded?.nextAttemptAt).toEqual(AT);
    expect(loaded?.isPending()).toBe(true);
  });

  it('insertIfAbsent: a primeira inserção retorna true e a repetida retorna false', async () => {
    const message = inboxMessage();

    const first = await uow.run(({ inbox }) => inbox.insertIfAbsent(message));
    const second = await uow.run(({ inbox }) =>
      inbox.insertIfAbsent(inboxMessage(message.messageId)),
    );
    const loaded = await uow.run(({ inbox }) =>
      inbox.findByKey(message.consumerName, message.messageId),
    );

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(loaded?.payloadHash).toBe('sha256-v1:abc');
    expect(loaded?.receivedAt).toEqual(AT);
    expect(loaded?.isProcessed()).toBe(false);
  });

  it('com duas transações simultâneas, a segunda espera o commit da primeira e recebe false', async () => {
    const message = inboxMessage();
    let signalInserted!: () => void;
    let releaseFirst!: () => void;
    const inserted = new Promise<void>((resolve) => (signalInserted = resolve));
    const released = new Promise<void>((resolve) => (releaseFirst = resolve));

    const first = uow.run(async ({ inbox }) => {
      const result = await inbox.insertIfAbsent(message);
      signalInserted();
      await released;
      return result;
    });
    await inserted;

    let secondSettled = false;
    const second = uow
      .run(({ inbox }) => inbox.insertIfAbsent(inboxMessage(message.messageId)))
      .finally(() => (secondSettled = true));
    await Bun.sleep(100);
    const settledBeforeCommit = secondSettled;
    releaseFirst();

    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(settledBeforeCommit).toBe(false);
  });

  it('a mesma messageId em outro consumidor não é duplicata', async () => {
    const message = inboxMessage();
    const otherConsumer = InboxMessage.receive({
      messageId: message.messageId,
      consumerName: 'other-consumer',
      payloadHash: 'sha256-v1:abc',
      receivedAt: AT,
    });

    await uow.run(({ inbox }) => inbox.insertIfAbsent(message));

    expect(await uow.run(({ inbox }) => inbox.insertIfAbsent(otherConsumer))).toBe(true);
  });

  it('outbox e inbox de uma unidade de trabalho que falha são desfeitas junto', async () => {
    const outboxMessage = balanceChangedMessage();
    const received = inboxMessage();

    await expect(
      uow.run(async ({ outbox, inbox }) => {
        await inbox.insertIfAbsent(received);
        await outbox.insert(outboxMessage);
        throw new Error('falha depois de gravar outbox e inbox');
      }),
    ).rejects.toThrow('falha depois de gravar outbox e inbox');

    const leftovers = await uow.run(async ({ outbox, inbox }) => ({
      outbox: await outbox.findById(outboxMessage.id),
      inbox: await inbox.findByKey(received.consumerName, received.messageId),
    }));
    expect(leftovers.outbox).toBeUndefined();
    expect(leftovers.inbox).toBeUndefined();
  });
});
