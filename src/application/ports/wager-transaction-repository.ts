import type { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import type { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status.js';

export interface ReferenceRetryCandidate {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  /** PENDING_REFERENCE com next_reference_attempt_at <= now, mais antigas primeiro. */
  findDueForReferenceRetry(now: Date, limit: number): Promise<ReferenceRetryCandidate[]>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  /** Existe um REFUND ou ROLLBACK PROCESSED que referencia esta transação? */
  hasProcessedReversalOf(transactionId: string): Promise<boolean>;
  insert(transaction: WagerTransaction): Promise<void>;
  /**
   * Grava o novo estado só se o status no banco ainda for o esperado. Impede
   * que duas execuções finalizem a mesma transação.
   */
  update(
    transaction: WagerTransaction,
    expectedPreviousStatus: WagerTransactionStatus,
  ): Promise<void>;
}
