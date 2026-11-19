import type { EventContext } from '../../domain/messaging/integration-event.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { MoneyOverflowError } from '../../domain/shared/domain-error.js';
import { WagerTransactionPendingReference } from '../../domain/wagering/events/wager-transaction-pending-reference.js';
import { WagerTransactionProcessed } from '../../domain/wagering/events/wager-transaction-processed.js';
import { WagerTransactionRejected } from '../../domain/wagering/events/wager-transaction-rejected.js';
import { WalletBalanceChanged } from '../../domain/wagering/events/wallet-balance-changed.js';
import { FailureCode } from '../../domain/wagering/failure-code.js';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status.js';
import { LedgerDirection } from '../../domain/wallet/ledger-direction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import { InsufficientFundsError } from '../../domain/wallet/wallet-errors.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { TransactionalRepositories } from '../ports/unit-of-work.js';
import type {
  SubmitWagerStatus,
  SubmitWagerTransactionResult,
} from './submit-wager-transaction.types.js';

/** Estado de uma execução, com a wallet já travada (FOR UPDATE). */
export interface ProcessingContext {
  repositories: TransactionalRepositories;
  transaction: WagerTransaction;
  wallet: Wallet;
  now: Date;
  eventContext: () => EventContext;
  /**
   * Grava a transação: insert quando é nova (entrada HTTP/SQS), update com
   * guarda de status quando vem do worker de referência pendente.
   */
  save: (transaction: WagerTransaction) => Promise<void>;
  /** Nova: o evento de referência pendente só é emitido na primeira vez. */
  isNew: boolean;
}

/**
 * Decisão e gravação de uma transação, compartilhada pelo caso de uso de
 * entrada e pelo worker de referência pendente: rejeições de contexto →
 * referência → aplicação no saldo → gravação na ordem transação, wallet,
 * lançamento, outbox.
 */
export class WagerTransactionProcessor {
  constructor(private readonly ids: IdGenerator) {}

  async process(context: ProcessingContext): Promise<SubmitWagerTransactionResult> {
    const { repositories, transaction, wallet } = context;

    if (wallet.playerId !== transaction.playerId) {
      return this.reject(context, FailureCode.WalletPlayerMismatch);
    }
    if (wallet.currency !== transaction.money.currency) {
      return this.reject(context, FailureCode.CurrencyMismatch);
    }

    let reference: WagerTransaction | undefined;
    if (transaction.referenceExternalTransactionId !== undefined) {
      reference = await repositories.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      // Ausente ou ainda pendente conta como ausente.
      if (!reference || !reference.isTerminal()) {
        return transaction.hasExhaustedReferenceAttempts()
          ? this.reject(context, FailureCode.ReferenceNotFound)
          : this.markPendingReference(context);
      }
      const failure = transaction.checkReference(reference);
      if (failure) {
        return this.reject(context, failure);
      }
      if (
        transaction.requiresReference() &&
        (await repositories.transactions.hasProcessedReversalOf(reference.id))
      ) {
        return this.reject(context, FailureCode.ReferenceAlreadyReversed);
      }
    }

    return this.apply(context, reference);
  }

  private async apply(
    context: ProcessingContext,
    reference: WagerTransaction | undefined,
  ): Promise<SubmitWagerTransactionResult> {
    const { repositories, transaction, wallet, now } = context;
    const previousVersion = wallet.version;
    let entry: WalletLedgerEntry | undefined;

    if (transaction.affectsBalance()) {
      const movement = {
        money: transaction.money,
        transactionId: transaction.id,
        entryId: this.ids.next(),
        at: now,
      };
      try {
        entry =
          transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit
            ? wallet.debit(movement)
            : wallet.credit(movement);
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          // Só BET e ROLLBACK debitam; a reversão sem saldo tem código próprio (regra 9).
          return this.reject(
            context,
            transaction.kind === WagerTransactionKind.Rollback
              ? FailureCode.ReversalInsufficientFunds
              : FailureCode.InsufficientFunds,
          );
        }
        if (error instanceof MoneyOverflowError) {
          return this.reject(context, FailureCode.AmountOutOfRange);
        }
        throw error;
      }
    }

    transaction.markProcessed(reference?.id, wallet.balance, now);

    await context.save(transaction);
    if (entry) {
      await repositories.wallets.update(wallet, previousVersion);
      await repositories.ledger.insert(entry);
    }
    await repositories.outbox.insert(
      OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, context.eventContext())),
    );
    if (entry) {
      await repositories.outbox.insert(
        OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, context.eventContext())),
      );
    }

    return toResult(transaction, false);
  }

  private async reject(
    { repositories, transaction, wallet, now, eventContext, save }: ProcessingContext,
    code: FailureCode,
  ): Promise<SubmitWagerTransactionResult> {
    transaction.reject(code, wallet.balance, now);
    await save(transaction);
    await repositories.outbox.insert(
      OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, eventContext())),
    );
    return toResult(transaction, false);
  }

  private async markPendingReference({
    repositories,
    transaction,
    now,
    eventContext,
    save,
    isNew,
  }: ProcessingContext): Promise<SubmitWagerTransactionResult> {
    transaction.markPendingReference(now);
    await save(transaction);
    if (isNew) {
      await repositories.outbox.insert(
        OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, eventContext())),
      );
    }
    return toResult(transaction, false);
  }
}

export function toResult(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): SubmitWagerTransactionResult {
  if (transaction.status === WagerTransactionStatus.Pending) {
    throw new Error(`Transação ${transaction.id} persistida em PENDING`);
  }
  const status: SubmitWagerStatus = transaction.status;
  const { resultingBalance, failureCode } = transaction;

  return {
    transactionId: transaction.id,
    status,
    ...(resultingBalance === undefined ? {} : { balance: resultingBalance.toJSON() }),
    ...(failureCode === undefined ? {} : { failureCode }),
    idempotentReplay,
  };
}
