import { type EventContext, IntegrationEvent } from '../../messaging/integration-event.js';
import type { WagerTransaction } from '../wager-transaction.js';
import { WagerTransactionStatus } from '../wager-transaction-status.js';
import { InvalidTransactionStateError } from '../wagering-errors.js';
import { type TransactionIdentityData, transactionIdentityData } from './transaction-event-data.js';

export interface WagerTransactionPendingReferenceData extends TransactionIdentityData {
  referenceExternalTransactionId: string;
  referenceAttempts: number;
  /** ISO-8601. */
  nextReferenceAttemptAt: string;
}

/**
 * Referência ausente. Publicado só quando a transação entra em
 * PENDING_REFERENCE; as novas tentativas não publicam de novo.
 */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  override readonly eventType = 'WagerTransactionPendingReference';
  override readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    const { referenceExternalTransactionId, nextReferenceAttemptAt } = transaction;
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      referenceExternalTransactionId === undefined ||
      nextReferenceAttemptAt === undefined
    ) {
      throw new InvalidTransactionStateError(
        `Evento de PENDING_REFERENCE para a transação ${transaction.id} em ${transaction.status}`,
      );
    }

    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.id,
      data: {
        ...transactionIdentityData(transaction),
        referenceExternalTransactionId,
        referenceAttempts: transaction.referenceAttempts,
        nextReferenceAttemptAt: nextReferenceAttemptAt.toISOString(),
      },
    });
  }
}
