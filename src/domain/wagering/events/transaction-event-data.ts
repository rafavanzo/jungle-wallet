import type { MoneyProps } from '../../shared/money.js';
import type { WagerTransaction } from '../wager-transaction.js';
import type { WagerTransactionKind } from '../wager-transaction-kind.js';
import type { WagerTransactionStatus } from '../wager-transaction-status.js';
import { InvalidTransactionStateError } from '../wagering-errors.js';

/** Campos que identificam a transação em todos os eventos de transação. */
export interface TransactionIdentityData {
  transactionId: string;
  walletId: string;
  playerId: string;
  providerId: string;
  externalTransactionId: string;
  kind: WagerTransactionKind;
}

/** Resultado final (PROCESSED ou REJECTED) de uma transação. */
export interface TransactionOutcomeData extends TransactionIdentityData {
  money: MoneyProps;
  resultingBalance: MoneyProps;
  referenceTransactionId?: string;
  /** ISO-8601. */
  processedAt: string;
}

export function transactionIdentityData(transaction: WagerTransaction): TransactionIdentityData {
  return {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    kind: transaction.kind,
  };
}

export function transactionOutcomeData(
  transaction: WagerTransaction,
  expectedStatus: WagerTransactionStatus,
): TransactionOutcomeData {
  const { resultingBalance, processedAt, referenceTransactionId } = transaction;
  if (
    transaction.status !== expectedStatus ||
    resultingBalance === undefined ||
    processedAt === undefined
  ) {
    throw new InvalidTransactionStateError(
      `Evento de ${expectedStatus} para a transação ${transaction.id} em ${transaction.status}`,
    );
  }

  return {
    ...transactionIdentityData(transaction),
    money: transaction.money.toJSON(),
    resultingBalance: resultingBalance.toJSON(),
    ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
    processedAt: processedAt.toISOString(),
  };
}
