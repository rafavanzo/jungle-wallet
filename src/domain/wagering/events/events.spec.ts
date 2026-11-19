import { describe, expect, it } from 'bun:test';

import type { EventContext } from '../../messaging/integration-event.js';
import { Money } from '../../shared/money.js';
import { LedgerDirection } from '../../wallet/ledger-direction.js';
import { Wallet } from '../../wallet/wallet.js';
import { FailureCode } from '../failure-code.js';
import { WagerTransaction } from '../wager-transaction.js';
import { WagerTransactionKind } from '../wager-transaction-kind.js';
import { InvalidTransactionStateError } from '../wagering-errors.js';
import { WagerTransactionPendingReference } from './wager-transaction-pending-reference.js';
import { WagerTransactionProcessed } from './wager-transaction-processed.js';
import { WagerTransactionRejected } from './wager-transaction-rejected.js';
import { WalletBalanceChanged } from './wallet-balance-changed.js';

const CREATED_AT = new Date('2026-11-19T10:00:00.000Z');
const PROCESSED_AT = new Date('2026-11-19T10:00:05.000Z');
const OCCURRED_AT = new Date('2026-11-19T10:00:06.000Z');

const ctx: EventContext = {
  eventId: 'event-1',
  correlationId: 'corr-1',
  causationId: 'cause-1',
  occurredAt: OCCURRED_AT,
};

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

function createTransaction(
  kind: WagerTransactionKind,
  referenceExternalTransactionId?: string,
): WagerTransaction {
  return WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-1',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'idem-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('25.00'),
    referenceExternalTransactionId,
    createdAt: CREATED_AT,
  });
}

function processedBet(): WagerTransaction {
  const tx = createTransaction(WagerTransactionKind.Bet);
  tx.markProcessed(undefined, brl('75.00'), PROCESSED_AT);
  return tx;
}

describe('eventos de integração', () => {
  describe('WagerTransactionProcessed', () => {
    it('toJSON tem o envelope completo, occurredAt em ISO e o tipo fixado na classe', () => {
      const event = WagerTransactionProcessed.from(processedBet(), ctx);
      const eventType: 'WagerTransactionProcessed' = event.eventType;

      expect(eventType).toBe('WagerTransactionProcessed');
      expect(event.toJSON()).toEqual({
        eventId: 'event-1',
        eventType: 'WagerTransactionProcessed',
        aggregateId: 'tx-1',
        correlationId: 'corr-1',
        causationId: 'cause-1',
        occurredAt: '2026-11-19T10:00:06.000Z',
        version: 1,
        data: {
          transactionId: 'tx-1',
          walletId: 'wallet-1',
          playerId: 'player-1',
          providerId: 'provider-1',
          externalTransactionId: 'ext-1',
          kind: WagerTransactionKind.Bet,
          money: { amount: '25.00', currency: 'BRL' },
          resultingBalance: { amount: '75.00', currency: 'BRL' },
          processedAt: '2026-11-19T10:00:05.000Z',
        },
      });
    });

    it('inclui referenceTransactionId quando a transação tem referência', () => {
      const refund = createTransaction(WagerTransactionKind.Refund, 'ext-bet');
      refund.markProcessed('tx-bet', brl('100.00'), PROCESSED_AT);

      const event = WagerTransactionProcessed.from(refund, ctx);

      expect(event.data.referenceTransactionId).toBe('tx-bet');
    });

    it('LOSS também gera WagerTransactionProcessed', () => {
      const loss = createTransaction(WagerTransactionKind.Loss);
      loss.markProcessed(undefined, brl('100.00'), PROCESSED_AT);

      expect(WagerTransactionProcessed.from(loss, ctx).data.kind).toBe(WagerTransactionKind.Loss);
    });

    it('rejeita transação que não está PROCESSED', () => {
      expect(() =>
        WagerTransactionProcessed.from(createTransaction(WagerTransactionKind.Bet), ctx),
      ).toThrow(InvalidTransactionStateError);
    });
  });

  describe('WagerTransactionRejected', () => {
    it('leva o failureCode e o saldo observado', () => {
      const tx = createTransaction(WagerTransactionKind.Bet);
      tx.reject(FailureCode.InsufficientFunds, brl('5.00'), PROCESSED_AT);

      const event = WagerTransactionRejected.from(tx, ctx);
      const eventType: 'WagerTransactionRejected' = event.eventType;

      expect(eventType).toBe('WagerTransactionRejected');
      expect(event.version).toBe(1);
      expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(event.data.resultingBalance).toEqual({ amount: '5.00', currency: 'BRL' });
    });

    it('rejeita transação que não está REJECTED', () => {
      expect(() => WagerTransactionRejected.from(processedBet(), ctx)).toThrow(
        InvalidTransactionStateError,
      );
    });
  });

  describe('WagerTransactionPendingReference', () => {
    it('leva a referência esperada e o agendamento da próxima tentativa', () => {
      const refund = createTransaction(WagerTransactionKind.Refund, 'ext-bet');
      refund.markPendingReference(CREATED_AT);

      const event = WagerTransactionPendingReference.from(refund, ctx);
      const eventType: 'WagerTransactionPendingReference' = event.eventType;

      expect(eventType).toBe('WagerTransactionPendingReference');
      expect(event.data).toEqual({
        transactionId: 'tx-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        providerId: 'provider-1',
        externalTransactionId: 'ext-1',
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'ext-bet',
        referenceAttempts: 1,
        nextReferenceAttemptAt: '2026-11-19T10:00:01.000Z',
      });
    });
  });

  describe('WalletBalanceChanged', () => {
    it('copia balanceBefore, balanceAfter, direção e walletVersion do lançamento', () => {
      const { wallet } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('100.00'),
        openingTransactionId: 'tx-opening',
        openingEntryId: 'entry-opening',
        at: CREATED_AT,
      });
      const entry = wallet.debit({
        money: brl('25.00'),
        transactionId: 'tx-1',
        entryId: 'entry-1',
        at: PROCESSED_AT,
      });

      const event = WalletBalanceChanged.from(wallet, entry, ctx);
      const eventType: 'WalletBalanceChanged' = event.eventType;

      expect(eventType).toBe('WalletBalanceChanged');
      expect(event.aggregateId).toBe('wallet-1');
      expect(event.data).toEqual({
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      });
    });
  });

  describe('data', () => {
    it('contém MoneyProps com strings: JSON.stringify seguido de JSON.parse devolve o mesmo objeto', () => {
      const event = WagerTransactionProcessed.from(processedBet(), ctx);
      const envelope = event.toJSON();

      expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
      expect(event.data.money).not.toBeInstanceOf(Money);
      expect(typeof event.data.money.amount).toBe('string');
    });

    it('é congelado, inclusive nos objetos aninhados', () => {
      const event = WagerTransactionProcessed.from(processedBet(), ctx);
      const data = event.data as { kind: string; money: { amount: string } };

      expect(() => {
        data.kind = 'WIN';
      }).toThrow(TypeError);
      expect(() => {
        data.money.amount = '0.01';
      }).toThrow(TypeError);
    });

    it('omite causationId do envelope quando ele não existe', () => {
      const { causationId: _omitted, ...withoutCausation } = ctx;

      const envelope = WagerTransactionProcessed.from(processedBet(), withoutCausation).toJSON();

      expect('causationId' in envelope).toBe(false);
      expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
    });
  });
});
