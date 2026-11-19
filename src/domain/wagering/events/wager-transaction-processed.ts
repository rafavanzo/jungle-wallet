import { type EventContext, IntegrationEvent } from '../../messaging/integration-event.js';
import type { WagerTransaction } from '../wager-transaction.js';
import { WagerTransactionStatus } from '../wager-transaction-status.js';
import { type TransactionOutcomeData, transactionOutcomeData } from './transaction-event-data.js';

export type WagerTransactionProcessedData = TransactionOutcomeData;

/** Qualquer transação aplicada, inclusive LOSS e OPENING. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  override readonly eventType = 'WagerTransactionProcessed';
  override readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.id,
      data: transactionOutcomeData(transaction, WagerTransactionStatus.Processed),
    });
  }
}
