import { describe, expect, it } from 'bun:test';

import { Money } from '../shared/money.js';
import { WalletBalanceChanged } from '../wagering/events/wallet-balance-changed.js';
import { Wallet } from '../wallet/wallet.js';
import { InvalidMessageStateError } from './messaging-errors.js';
import { OutboxMessage } from './outbox-message.js';

const OCCURRED_AT = new Date('2026-11-19T10:00:00.000Z');
const NOW = new Date('2026-11-19T10:01:00.000Z');

const at = (base: Date, seconds: number): Date => new Date(base.getTime() + seconds * 1000);

function enqueuedMessage(): OutboxMessage {
  const { wallet } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    at: OCCURRED_AT,
  });
  const entry = wallet.debit({
    money: Money.from({ amount: '10.00', currency: 'BRL' }),
    transactionId: 'tx-1',
    entryId: 'entry-1',
    at: OCCURRED_AT,
  });
  const event = WalletBalanceChanged.from(wallet, entry, {
    eventId: 'event-1',
    correlationId: 'corr-1',
    occurredAt: OCCURRED_AT,
  });
  return OutboxMessage.enqueue(event);
}

describe('OutboxMessage', () => {
  it('enqueue usa o eventId como id, o envelope como payload e vence na hora', () => {
    const message = enqueuedMessage();

    expect(message.id).toBe('event-1');
    expect(message.aggregateId).toBe('wallet-1');
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toMatchObject({ eventId: 'event-1', version: 1 });
    expect(message.attempts).toBe(0);
    expect(message.nextAttemptAt).toEqual(OCCURRED_AT);
    expect(message.isPending()).toBe(true);
    expect(message.isDue(OCCURRED_AT)).toBe(true);
    expect(message.lastError).toBeUndefined();
  });

  it('scheduleRetry segue 2s, 4s, 8s... até o teto de 5 minutos e guarda o erro', () => {
    const message = enqueuedMessage();
    const expectedDelays = [2, 4, 8, 16, 32, 64, 128, 256, 300, 300];

    expectedDelays.forEach((delay, index) => {
      message.scheduleRetry(NOW, `falha ${index + 1}`);

      expect(message.attempts).toBe(index + 1);
      expect(message.nextAttemptAt).toEqual(at(NOW, delay));
      expect(message.lastError).toBe(`falha ${index + 1}`);
    });
  });

  it('isDue respeita o nextAttemptAt', () => {
    const message = enqueuedMessage();
    message.scheduleRetry(NOW, 'timeout');

    expect(message.isDue(at(NOW, 1.999))).toBe(false);
    expect(message.isDue(at(NOW, 2))).toBe(true);
  });

  it('markPublished encerra a mensagem; publicar de novo lança erro', () => {
    const message = enqueuedMessage();

    message.markPublished(NOW);

    expect(message.isPending()).toBe(false);
    expect(message.isDue(at(NOW, 3600))).toBe(false);
    expect(message.publishedAt).toEqual(NOW);
    expect(() => message.markPublished(NOW)).toThrow(InvalidMessageStateError);
    expect(() => message.scheduleRetry(NOW, 'x')).toThrow(InvalidMessageStateError);
  });

  it('o payload é congelado', () => {
    const message = enqueuedMessage();
    const payload = message.payload as { eventId: string };

    expect(() => {
      payload.eventId = 'outro';
    }).toThrow(TypeError);
  });
});
