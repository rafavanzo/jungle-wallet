import { describe, expect, it } from 'bun:test';

import { InvalidAmountError } from '../shared/domain-error.js';
import { Money } from '../shared/money.js';
import { LedgerDirection } from '../wallet/ledger-direction.js';
import { FailureCode } from './failure-code.js';
import {
  type CreateWagerTransactionProps,
  INTERNAL_PROVIDER_ID,
  MAX_REFERENCE_ATTEMPTS,
  WagerTransaction,
  type WagerTransactionState,
} from './wager-transaction.js';
import { WagerTransactionKind as Kind } from './wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from './wager-transaction-status.js';
import {
  InvalidTransactionStateError,
  MissingReferenceError,
  ReservedProviderIdError,
  SelfReferenceError,
  UnexpectedReferenceError,
  UnsupportedTransactionKindError,
} from './wagering-errors.js';

const CREATED_AT = new Date('2026-11-19T10:00:00.000Z');
const PROCESSED_AT = new Date('2026-11-19T10:00:05.000Z');
const REFERENCE_EXTERNAL_ID = 'ext-ref';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

const txProps = (
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps => ({
  id: 'tx-1',
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'idem-1',
  payloadHash: 'hash-1',
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: Kind.Bet,
  money: brl('10.00'),
  referenceExternalTransactionId: undefined,
  createdAt: CREATED_AT,
  ...overrides,
});

const createTx = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
  WagerTransaction.create(txProps(overrides));

const referencingTx = (
  kind: Kind,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction =>
  createTx({ kind, referenceExternalTransactionId: REFERENCE_EXTERNAL_ID, ...overrides });

const referenceTx = (
  kind: Kind,
  overrides: Partial<WagerTransactionState> = {},
): WagerTransaction =>
  WagerTransaction.rehydrate({
    ...txProps({ id: 'tx-ref', externalTransactionId: REFERENCE_EXTERNAL_ID, kind }),
    status: Status.Processed,
    referenceTransactionId: undefined,
    failureCode: undefined,
    processedAt: PROCESSED_AT,
    resultingBalance: brl('90.00'),
    referenceAttempts: 0,
    nextReferenceAttemptAt: undefined,
    ...overrides,
  });

const pendingReferenceTx = (): WagerTransaction => {
  const tx = referencingTx(Kind.Refund);
  tx.markPendingReference(CREATED_AT);
  return tx;
};

const terminalTx = (status: Status): WagerTransaction => {
  const tx = createTx();
  if (status === Status.Processed) tx.markProcessed(undefined, brl('90.00'), PROCESSED_AT);
  if (status === Status.Rejected)
    tx.reject(FailureCode.InsufficientFunds, brl('5.00'), PROCESSED_AT);
  if (status === Status.Failed) tx.fail(FailureCode.ProcessingFailed, PROCESSED_AT);
  return tx;
};

describe('WagerTransaction', () => {
  describe('create', () => {
    it('BET válido nasce PENDING', () => {
      const tx = createTx();

      expect(tx.status).toBe(Status.Pending);
      expect(tx.kind).toBe(Kind.Bet);
      expect(tx.money.toString()).toBe('10.00');
      expect(tx.gameId).toBe('game-1');
      expect(tx.createdAt).toEqual(CREATED_AT);
      expect(tx.isTerminal()).toBe(false);
      expect(tx.referenceAttempts).toBe(0);
      expect(tx.processedAt).toBeUndefined();
      expect(tx.resultingBalance).toBeUndefined();
      expect(tx.failureCode).toBeUndefined();
    });

    it('rejeita OPENING', () => {
      expect(() => createTx({ kind: Kind.Opening })).toThrow(UnsupportedTransactionKindError);
    });

    it('rejeita o providerId reservado para transações internas', () => {
      expect(() => createTx({ providerId: INTERNAL_PROVIDER_ID })).toThrow(ReservedProviderIdError);
    });

    it.each([Kind.Refund, Kind.Rollback])('rejeita %s sem referência', (kind) => {
      expect(() => createTx({ kind })).toThrow(MissingReferenceError);
    });

    it.each([Kind.Win, Kind.Loss])('aceita %s sem referência', (kind) => {
      expect(createTx({ kind }).status).toBe(Status.Pending);
    });

    it('rejeita BET com referência', () => {
      expect(() => referencingTx(Kind.Bet)).toThrow(UnexpectedReferenceError);
    });

    it('rejeita referência para a própria transação', () => {
      const props = {
        externalTransactionId: 'ext-self',
        referenceExternalTransactionId: 'ext-self',
      };

      expect(() => createTx({ kind: Kind.Refund, ...props })).toThrow(SelfReferenceError);
    });

    it.each([Kind.Bet, Kind.Win])('rejeita %s com valor 0.00', (kind) => {
      expect(() => createTx({ kind, money: brl('0.00') })).toThrow(InvalidAmountError);
    });

    it.each([Kind.Refund, Kind.Rollback])('rejeita %s com valor 0.00', (kind) => {
      expect(() => referencingTx(kind, { money: brl('0.00') })).toThrow(InvalidAmountError);
    });

    it('aceita LOSS com valor 0.00', () => {
      const tx = createTx({ kind: Kind.Loss, money: brl('0.00') });

      expect(tx.status).toBe(Status.Pending);
      expect(tx.money.isZero()).toBe(true);
    });
  });

  describe('opening', () => {
    it('nasce PROCESSED com saldo resultante e processedAt preenchidos', () => {
      const tx = WagerTransaction.opening({
        id: 'tx-opening',
        walletId: 'wallet-1',
        playerId: 'player-1',
        money: brl('1000.00'),
        at: CREATED_AT,
      });

      expect(tx.kind).toBe(Kind.Opening);
      expect(tx.status).toBe(Status.Processed);
      expect(tx.providerId).toBe(INTERNAL_PROVIDER_ID);
      expect(tx.resultingBalance?.toString()).toBe('1000.00');
      expect(tx.processedAt).toEqual(CREATED_AT);
      expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    });
  });

  describe('transições', () => {
    it.each([
      ['PENDING', createTx],
      ['PENDING_REFERENCE', pendingReferenceTx],
    ])('de %s para PROCESSED', (_from, build) => {
      const tx = build();
      const referenceId = tx.referenceExternalTransactionId ? 'tx-ref' : undefined;

      tx.markProcessed(referenceId, brl('90.00'), PROCESSED_AT);

      expect(tx.status).toBe(Status.Processed);
      expect(tx.referenceTransactionId).toBe(referenceId);
    });

    it.each([
      ['PENDING', createTx],
      ['PENDING_REFERENCE', pendingReferenceTx],
    ])('de %s para REJECTED', (_from, build) => {
      const tx = build();

      tx.reject(FailureCode.ReferenceNotFound, brl('100.00'), PROCESSED_AT);

      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.ReferenceNotFound);
    });

    it.each([
      ['PENDING', createTx],
      ['PENDING_REFERENCE', pendingReferenceTx],
    ])('de %s para FAILED', (_from, build) => {
      const tx = build();

      tx.fail(FailureCode.ProcessingFailed, PROCESSED_AT);

      expect(tx.status).toBe(Status.Failed);
      expect(tx.failureCode).toBe(FailureCode.ProcessingFailed);
      expect(tx.processedAt).toEqual(PROCESSED_AT);
    });

    it('de PENDING para PENDING_REFERENCE e de volta a PENDING_REFERENCE', () => {
      const tx = referencingTx(Kind.Refund);

      tx.markPendingReference(CREATED_AT);
      expect(tx.status).toBe(Status.PendingReference);

      tx.markPendingReference(CREATED_AT);
      expect(tx.status).toBe(Status.PendingReference);
      expect(tx.referenceAttempts).toBe(2);
    });

    it('markPendingReference agenda as tentativas com backoff exponencial e teto de 5 minutos', () => {
      const tx = referencingTx(Kind.Refund);
      const expectedDelaysInSeconds = [1, 2, 4, 8, 16, 32, 64, 128, 256, 300];

      expectedDelaysInSeconds.forEach((delay, index) => {
        tx.markPendingReference(CREATED_AT);

        expect(tx.referenceAttempts).toBe(index + 1);
        expect(tx.nextReferenceAttemptAt).toEqual(new Date(CREATED_AT.getTime() + delay * 1000));
      });
    });

    it('isDueForReferenceRetry só é verdadeiro a partir do horário agendado', () => {
      const tx = referencingTx(Kind.Refund);
      tx.markPendingReference(CREATED_AT);

      expect(tx.isDueForReferenceRetry(new Date(CREATED_AT.getTime() + 999))).toBe(false);
      expect(tx.isDueForReferenceRetry(new Date(CREATED_AT.getTime() + 1000))).toBe(true);

      tx.reject(FailureCode.ReferenceNotFound, brl('100.00'), PROCESSED_AT);
      expect(tx.isDueForReferenceRetry(new Date(CREATED_AT.getTime() + 60_000))).toBe(false);
    });

    it('hasExhaustedReferenceAttempts após o limite de tentativas', () => {
      const tx = referencingTx(Kind.Refund);

      for (let attempt = 1; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
        tx.markPendingReference(CREATED_AT);
      }
      expect(tx.hasExhaustedReferenceAttempts()).toBe(false);

      tx.markPendingReference(CREATED_AT);
      expect(tx.hasExhaustedReferenceAttempts()).toBe(true);
    });

    const terminalStatuses = [Status.Processed, Status.Rejected, Status.Failed];
    const transitions: [string, (tx: WagerTransaction) => void][] = [
      ['markProcessed', (tx) => tx.markProcessed(undefined, brl('1.00'), PROCESSED_AT)],
      ['markPendingReference', (tx) => tx.markPendingReference(PROCESSED_AT)],
      ['reject', (tx) => tx.reject(FailureCode.InsufficientFunds, brl('1.00'), PROCESSED_AT)],
      ['fail', (tx) => tx.fail(FailureCode.ProcessingFailed, PROCESSED_AT)],
    ];

    it.each(
      terminalStatuses.flatMap((status) =>
        transitions.map(([name, transition]) => [status, name, transition] as const),
      ),
    )('a partir de %s, %s lança InvalidTransactionStateError', (status, _name, transition) => {
      const tx = terminalTx(status);

      expect(tx.isTerminal()).toBe(true);
      expect(() => transition(tx)).toThrow(InvalidTransactionStateError);
      expect(tx.status).toBe(status);
    });

    it('markProcessed guarda resultingBalance e processedAt', () => {
      const tx = createTx();

      tx.markProcessed(undefined, brl('90.00'), PROCESSED_AT);

      expect(tx.resultingBalance?.toString()).toBe('90.00');
      expect(tx.processedAt).toEqual(PROCESSED_AT);
      expect(tx.failureCode).toBeUndefined();
    });

    it('reject guarda failureCode, resultingBalance e processedAt', () => {
      const tx = createTx();

      tx.reject(FailureCode.InsufficientFunds, brl('5.00'), PROCESSED_AT);

      expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(tx.resultingBalance?.toString()).toBe('5.00');
      expect(tx.processedAt).toEqual(PROCESSED_AT);
    });

    it('markProcessed exige o id interno quando há referência', () => {
      const tx = referencingTx(Kind.Refund);

      expect(() => tx.markProcessed(undefined, brl('1.00'), PROCESSED_AT)).toThrow(
        MissingReferenceError,
      );
    });

    it('markProcessed rejeita id de referência numa transação sem referência', () => {
      const tx = createTx();

      expect(() => tx.markProcessed('tx-ref', brl('1.00'), PROCESSED_AT)).toThrow(
        UnexpectedReferenceError,
      );
    });
  });

  describe('regras por tipo', () => {
    it.each([
      [Kind.Opening, true],
      [Kind.Bet, true],
      [Kind.Win, true],
      [Kind.Loss, false],
      [Kind.Refund, true],
      [Kind.Rollback, true],
    ])('affectsBalance de %s é %p', (kind, expected) => {
      const tx = referenceTx(kind);

      expect(tx.affectsBalance()).toBe(expected);
    });

    it.each([
      [Kind.Opening, false],
      [Kind.Bet, false],
      [Kind.Win, false],
      [Kind.Loss, false],
      [Kind.Refund, true],
      [Kind.Rollback, true],
    ])('requiresReference de %s é %p', (kind, expected) => {
      expect(referenceTx(kind).requiresReference()).toBe(expected);
    });

    it.each([
      [Kind.Bet, LedgerDirection.Debit],
      [Kind.Win, LedgerDirection.Credit],
      [Kind.Refund, LedgerDirection.Credit],
      [Kind.Opening, LedgerDirection.Credit],
    ])('ledgerDirectionFor de %s é %s', (kind, expected) => {
      expect(referenceTx(kind).ledgerDirectionFor()).toBe(expected);
    });

    it.each([
      [Kind.Bet, LedgerDirection.Credit],
      [Kind.Win, LedgerDirection.Debit],
      [Kind.Refund, LedgerDirection.Debit],
    ])('ledgerDirectionFor de ROLLBACK de %s é %s', (referenceKind, expected) => {
      const rollback = referencingTx(Kind.Rollback);

      expect(rollback.ledgerDirectionFor(referenceTx(referenceKind))).toBe(expected);
    });

    it('ledgerDirectionFor de LOSS lança erro', () => {
      expect(() => createTx({ kind: Kind.Loss }).ledgerDirectionFor()).toThrow(
        UnsupportedTransactionKindError,
      );
    });

    it('ledgerDirectionFor de ROLLBACK sem a referência lança erro', () => {
      expect(() => referencingTx(Kind.Rollback).ledgerDirectionFor()).toThrow(
        MissingReferenceError,
      );
    });
  });

  describe('checkReference', () => {
    it.each([
      [Kind.Win, Kind.Bet],
      [Kind.Loss, Kind.Bet],
      [Kind.Refund, Kind.Bet],
      [Kind.Rollback, Kind.Bet],
      [Kind.Rollback, Kind.Win],
      [Kind.Rollback, Kind.Refund],
    ])('%s de um %s compatível retorna undefined', (kind, referenceKind) => {
      expect(referencingTx(kind).checkReference(referenceTx(referenceKind))).toBeUndefined();
    });

    it.each([
      ['provider', { providerId: 'provider-2' }],
      ['player', { playerId: 'player-2' }],
      ['wallet', { walletId: 'wallet-2' }],
      ['moeda', { money: usd('10.00') }],
      ['rodada', { roundId: 'round-2' }],
    ])('%s divergente retorna REFERENCE_MISMATCH', (_field, overrides) => {
      const refund = referencingTx(Kind.Refund);

      expect(refund.checkReference(referenceTx(Kind.Bet, overrides))).toBe(
        FailureCode.ReferenceMismatch,
      );
    });

    it.each([
      [Kind.Refund, Kind.Win],
      [Kind.Rollback, Kind.Loss],
      [Kind.Win, Kind.Win],
      [Kind.Rollback, Kind.Opening],
    ])('%s de um %s retorna REFERENCE_INVALID_KIND', (kind, referenceKind) => {
      expect(referencingTx(kind).checkReference(referenceTx(referenceKind))).toBe(
        FailureCode.ReferenceInvalidKind,
      );
    });

    it.each([Kind.Refund, Kind.Rollback])(
      '%s com valor diferente da referência retorna REFERENCE_AMOUNT_MISMATCH',
      (kind) => {
        const reversal = referencingTx(kind, { money: brl('9.99') });

        expect(reversal.checkReference(referenceTx(Kind.Bet))).toBe(
          FailureCode.ReferenceAmountMismatch,
        );
      },
    );

    it('WIN com valor diferente do BET referenciado é compatível', () => {
      const win = referencingTx(Kind.Win, { money: brl('50.00') });

      expect(win.checkReference(referenceTx(Kind.Bet))).toBeUndefined();
    });

    it.each([Status.Rejected, Status.Failed])(
      'referência %s retorna REFERENCE_NOT_PROCESSED',
      (status) => {
        const refund = referencingTx(Kind.Refund);

        expect(refund.checkReference(referenceTx(Kind.Bet, { status }))).toBe(
          FailureCode.ReferenceNotProcessed,
        );
      },
    );

    it.each([Status.Pending, Status.PendingReference])(
      'referência %s lança InvalidTransactionStateError',
      (status) => {
        const refund = referencingTx(Kind.Refund);

        expect(() => refund.checkReference(referenceTx(Kind.Bet, { status }))).toThrow(
          InvalidTransactionStateError,
        );
      },
    );

    it('transação que não é a referência informada lança erro', () => {
      const refund = referencingTx(Kind.Refund);
      const other = referenceTx(Kind.Bet, { externalTransactionId: 'ext-other' });

      expect(() => refund.checkReference(other)).toThrow(UnexpectedReferenceError);
    });
  });

  describe('idempotência', () => {
    it('matchesPayload compara o hash do payload', () => {
      const tx = createTx({ payloadHash: 'hash-original' });

      expect(tx.matchesPayload('hash-original')).toBe(true);
      expect(tx.matchesPayload('hash-divergente')).toBe(false);
    });
  });
});
