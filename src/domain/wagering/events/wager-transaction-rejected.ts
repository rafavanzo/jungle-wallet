import { type EventContext, IntegrationEvent } from '../../messaging/integration-event.js';
import type { FailureCode } from '../failure-code.js';
import type { WagerTransaction } from '../wager-transaction.js';
import { WagerTransactionStatus } from '../wager-transaction-status.js';
import { InvalidTransactionStateError } from '../wagering-errors.js';
import { type TransactionOutcomeData, transactionOutcomeData } from './transaction-event-data.js';

export interface WagerTransactionRejectedData extends TransactionOutcomeData {
  failureCode: FailureCode;
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  override readonly eventType = 'WagerTransactionRejected';
  override readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    const outcome = transactionOutcomeData(transaction, WagerTransactionStatus.Rejected);
    const { failureCode } = transaction;
    if (failureCode === undefined) {
      throw new InvalidTransactionStateError(
        `Transação ${transaction.id} rejeitada sem failureCode`,
      );
    }

    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.id,
      data: { ...outcome, failureCode },
    });
  }
}
