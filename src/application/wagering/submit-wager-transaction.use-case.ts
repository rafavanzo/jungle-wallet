import type { EventContext } from '../../domain/messaging/integration-event.js';
import { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import { MoneyOverflowError } from '../../domain/shared/domain-error.js';
import { Money } from '../../domain/shared/money.js';
import { WagerTransactionPendingReference } from '../../domain/wagering/events/wager-transaction-pending-reference.js';
import { WagerTransactionProcessed } from '../../domain/wagering/events/wager-transaction-processed.js';
import { WagerTransactionRejected } from '../../domain/wagering/events/wager-transaction-rejected.js';
import { WalletBalanceChanged } from '../../domain/wagering/events/wallet-balance-changed.js';
import { FailureCode } from '../../domain/wagering/failure-code.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status.js';
import { LedgerDirection } from '../../domain/wallet/ledger-direction.js';
import type { Wallet } from '../../domain/wallet/wallet.js';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';
import { InsufficientFundsError } from '../../domain/wallet/wallet-errors.js';
import { IdempotencyConflictError, WalletNotFoundError } from '../errors/application-errors.js';
import type { WageringMetrics } from '../metrics/wagering-metrics.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import {
  TransientInfrastructureError,
  UniqueConstraint,
  UniqueViolationError,
} from '../ports/persistence-errors.js';
import type { TransactionalRepositories, UnitOfWork } from '../ports/unit-of-work.js';
import { computePayloadHash } from './payload-hash.js';
import type {
  SubmitWagerStatus,
  SubmitWagerTransactionCommand,
  SubmitWagerTransactionResult,
} from './submit-wager-transaction.types.js';

/**
 * Violações de unicidade que significam "outra execução commitou primeiro"
 * (F5): uma nova tentativa encontra o que foi commitado e responde certo.
 */
const RETRYABLE_CONSTRAINTS: ReadonlySet<string> = new Set([
  UniqueConstraint.TransactionIdempotencyKey,
  UniqueConstraint.TransactionExternalId,
  UniqueConstraint.SingleReversal,
]);

/** Estado de uma execução, para não espalhar parâmetros pelos passos. */
interface Execution {
  repositories: TransactionalRepositories;
  transaction: WagerTransaction;
  wallet: Wallet;
  now: Date;
  eventContext: () => EventContext;
}

/**
 * Submete uma operação de aposta. Mesmo caso de uso para HTTP e SQS.
 *
 * Fluxo (F1 a F7): lock da wallet → idempotência → rejeições de contexto →
 * referência → aplicação no saldo → gravação na ordem transação, wallet,
 * lançamento, outbox. Tudo numa transação SQL.
 */
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: WageringMetrics,
  ) {}

  async execute(command: SubmitWagerTransactionCommand): Promise<SubmitWagerTransactionResult> {
    const startedAt = this.clock.now();
    // Fora da transação: valida (de novo, defesa em profundidade) e calcula o hash.
    const money = Money.from(command.money);
    const payloadHash = computePayloadHash(command);
    const transactionId = this.ids.next();

    const attempt = () => {
      const transaction = WagerTransaction.create({
        id: transactionId,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId ?? undefined,
        createdAt: startedAt,
      });
      return this.uow.run((repositories) => this.process(repositories, transaction, command));
    };

    try {
      const result = await this.retryOnceOnConcurrentCommit(attempt);
      this.recordMetrics(result, command.kind, startedAt);
      return result;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        this.metrics.duplicateDetected('idempotency_conflict');
      }
      if (error instanceof TransientInfrastructureError && error.lockTimeout) {
        this.metrics.lockTimeout();
      }
      throw error;
    }
  }

  private async process(
    repositories: TransactionalRepositories,
    transaction: WagerTransaction,
    command: SubmitWagerTransactionCommand,
  ): Promise<SubmitWagerTransactionResult> {
    const now = this.clock.now();

    // A partir daqui nenhuma outra execução mexe nesta wallet até o commit (F1).
    const wallet = await repositories.wallets.lockById(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`Wallet ${command.walletId} não encontrada`);
    }

    const replay = await this.checkIdempotency(repositories, transaction);
    if (replay) {
      return replay;
    }

    const execution: Execution = {
      repositories,
      transaction,
      wallet,
      now,
      eventContext: () => ({
        eventId: this.ids.next(),
        correlationId: command.correlationId,
        ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
        occurredAt: now,
      }),
    };

    if (wallet.playerId !== transaction.playerId) {
      return this.reject(execution, FailureCode.WalletPlayerMismatch);
    }
    if (wallet.currency !== transaction.money.currency) {
      return this.reject(execution, FailureCode.CurrencyMismatch);
    }

    let reference: WagerTransaction | undefined;
    if (transaction.referenceExternalTransactionId !== undefined) {
      reference = await repositories.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      // Ausente ou ainda pendente conta como ausente.
      if (!reference || !reference.isTerminal()) {
        return this.markPendingReference(execution);
      }
      const failure = transaction.checkReference(reference);
      if (failure) {
        return this.reject(execution, failure);
      }
      if (
        transaction.requiresReference() &&
        (await repositories.transactions.hasProcessedReversalOf(reference.id))
      ) {
        return this.reject(execution, FailureCode.ReferenceAlreadyReversed);
      }
    }

    return this.apply(execution, reference);
  }

  /** Passo 5: replay com o resultado original, ou conflito. */
  private async checkIdempotency(
    { transactions }: TransactionalRepositories,
    transaction: WagerTransaction,
  ): Promise<SubmitWagerTransactionResult | undefined> {
    const existing = await transactions.findByIdempotencyKey(
      transaction.providerId,
      transaction.idempotencyKey,
    );
    if (existing) {
      if (!existing.matchesPayload(transaction.payloadHash)) {
        throw new IdempotencyConflictError(
          'IDEMPOTENCY_KEY_REUSED',
          `A idempotency key ${transaction.idempotencyKey} já foi usada com outro payload`,
        );
      }
      return toResult(existing, true);
    }

    const sameExternalId = await transactions.findByExternalId(
      transaction.providerId,
      transaction.externalTransactionId,
    );
    if (sameExternalId) {
      throw new IdempotencyConflictError(
        'EXTERNAL_TRANSACTION_ID_CONFLICT',
        `A transação ${transaction.externalTransactionId} já existe com outra idempotency key`,
      );
    }
    return undefined;
  }

  /** Passo 9: aplica no saldo (se o kind afeta saldo) e grava na ordem do passo 10. */
  private async apply(
    execution: Execution,
    reference: WagerTransaction | undefined,
  ): Promise<SubmitWagerTransactionResult> {
    const { repositories, transaction, wallet, now } = execution;
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
            execution,
            transaction.kind === WagerTransactionKind.Rollback
              ? FailureCode.ReversalInsufficientFunds
              : FailureCode.InsufficientFunds,
          );
        }
        if (error instanceof MoneyOverflowError) {
          return this.reject(execution, FailureCode.AmountOutOfRange);
        }
        throw error;
      }
    }

    transaction.markProcessed(reference?.id, wallet.balance, now);

    await repositories.transactions.insert(transaction);
    if (entry) {
      await repositories.wallets.update(wallet, previousVersion);
      await repositories.ledger.insert(entry);
    }
    await repositories.outbox.insert(
      OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, execution.eventContext())),
    );
    if (entry) {
      await repositories.outbox.insert(
        OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, execution.eventContext())),
      );
    }

    return toResult(transaction, false);
  }

  private async reject(
    { repositories, transaction, wallet, now, eventContext }: Execution,
    code: FailureCode,
  ): Promise<SubmitWagerTransactionResult> {
    transaction.reject(code, wallet.balance, now);
    await repositories.transactions.insert(transaction);
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
  }: Execution): Promise<SubmitWagerTransactionResult> {
    transaction.markPendingReference(now);
    await repositories.transactions.insert(transaction);
    await repositories.outbox.insert(
      OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, eventContext())),
    );
    return toResult(transaction, false);
  }

  /**
   * F5: se outra execução commitou primeiro algo que esta também tentou gravar,
   * tenta mais uma vez, do início. Uma segunda violação é anomalia (bug).
   */
  private async retryOnceOnConcurrentCommit<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      if (!isRetryableUniqueViolation(error)) {
        throw error;
      }
    }
    try {
      return await attempt();
    } catch (error) {
      if (isRetryableUniqueViolation(error)) {
        throw new Error('Violação de unicidade persistente após nova tentativa', {
          cause: error,
        });
      }
      throw error;
    }
  }

  private recordMetrics(
    result: SubmitWagerTransactionResult,
    kind: WagerTransactionKind,
    startedAt: Date,
  ): void {
    if (result.idempotentReplay) {
      this.metrics.duplicateDetected('idempotent_replay');
      return;
    }
    const latencyMs = this.clock.now().getTime() - startedAt.getTime();
    this.metrics.transactionFinished(result.status, kind, latencyMs);
  }
}

function isRetryableUniqueViolation(error: unknown): boolean {
  return (
    error instanceof UniqueViolationError &&
    error.constraint !== undefined &&
    RETRYABLE_CONSTRAINTS.has(error.constraint)
  );
}

function toResult(
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
