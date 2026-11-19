import { describe, expect, it } from 'bun:test';

import { FailureCode } from '../domain/wagering/failure-code.js';
import { WagerTransactionStatus } from '../domain/wagering/wager-transaction-status.js';
import { ERROR_STATUS, type ErrorCode, statusForResult } from './error-status-map.js';

describe('ERROR_STATUS', () => {
  it.each<[ErrorCode, number]>([
    ['VALIDATION_ERROR', 400],
    ['INVALID_MONEY', 400],
    ['MISSING_IDEMPOTENCY_KEY', 400],
    ['RESERVED_PROVIDER_ID', 400],
    ['INVALID_CURSOR', 400],
    ['WALLET_NOT_FOUND', 404],
    ['TRANSACTION_NOT_FOUND', 404],
    ['WALLET_ALREADY_EXISTS', 409],
    ['IDEMPOTENCY_KEY_REUSED', 409],
    ['EXTERNAL_TRANSACTION_ID_CONFLICT', 409],
    ['TRANSIENT_INFRASTRUCTURE', 503],
    ['INTERNAL_ERROR', 500],
    ['INVALID_TRANSACTION_STATE', 500],
  ])('%s → %i', (code, status) => {
    expect(ERROR_STATUS[code]).toBe(status);
  });

  it.each(Object.values(FailureCode))('rejeição de negócio %s → 422', (code) => {
    expect(ERROR_STATUS[code]).toBe(422);
  });

  it('só o 503 sinaliza que o provedor pode reenviar', () => {
    const retryable = Object.entries(ERROR_STATUS).filter(([, status]) => status === 503);

    expect(retryable.map(([code]) => code)).toEqual(['TRANSIENT_INFRASTRUCTURE']);
  });
});

describe('statusForResult', () => {
  const result = (status: WagerTransactionStatus, idempotentReplay: boolean) => ({
    transactionId: 'tx-1',
    status: status as Exclude<WagerTransactionStatus, WagerTransactionStatus.Pending>,
    idempotentReplay,
  });

  it.each([
    [WagerTransactionStatus.Processed, false, 201],
    [WagerTransactionStatus.Processed, true, 200],
    [WagerTransactionStatus.PendingReference, false, 202],
    [WagerTransactionStatus.PendingReference, true, 202],
    [WagerTransactionStatus.Rejected, false, 422],
    [WagerTransactionStatus.Rejected, true, 422],
    [WagerTransactionStatus.Failed, false, 422],
  ])('%s (replay=%p) → %i', (status, replay, expected) => {
    expect(statusForResult(result(status, replay))).toBe(expected);
  });
});
