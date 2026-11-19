import { Money } from '../../../domain/shared/money.js';
import { FailureCode } from '../../../domain/wagering/failure-code.js';
import { WagerTransaction } from '../../../domain/wagering/wager-transaction.js';
import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status.js';
import type { WagerTransactionRecord } from '../records/wager-transaction.record.js';
import { parseEnum } from './parse-enum.js';

export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    const money = (amount: string) => Money.from({ amount, currency: record.currency });

    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: parseEnum(WagerTransactionKind, record.kind, 'kind'),
      money: money(record.amount),
      referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
      createdAt: record.createdAt,
      status: parseEnum(WagerTransactionStatus, record.status, 'status'),
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      failureCode:
        record.failureCode === null
          ? undefined
          : parseEnum(FailureCode, record.failureCode, 'failure_code'),
      processedAt: record.processedAt ?? undefined,
      resultingBalance:
        record.resultingBalance === null ? undefined : money(record.resultingBalance),
      referenceAttempts: record.referenceAttempts,
      nextReferenceAttemptAt: record.nextReferenceAttemptAt ?? undefined,
    });
  },

  toRecord(transaction: WagerTransaction): WagerTransactionRecord {
    return {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: transaction.money.toString(),
      currency: transaction.money.currency,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      status: transaction.status,
      failureCode: transaction.failureCode ?? null,
      resultingBalance: transaction.resultingBalance?.toString() ?? null,
      referenceAttempts: transaction.referenceAttempts,
      nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt ?? null,
    };
  },
};
