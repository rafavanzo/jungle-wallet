import { InboxMessage } from '../../domain/messaging/inbox-message.js';
import { Money } from '../../domain/shared/money.js';
import { WagerTransaction } from '../../domain/wagering/wager-transaction.js';
import type { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind.js';
import {
  DuplicateMessageError,
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../errors/application-errors.js';
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
  InboxReceipt,
  SubmitWagerTransactionCommand,
  SubmitWagerTransactionResult,
} from './submit-wager-transaction.types.js';
import { toResult, WagerTransactionProcessor } from './wager-transaction-processor.js';

/**
 * Violações de unicidade que significam "outra execução commitou primeiro"
 * (F5): uma nova tentativa encontra o que foi commitado e responde certo.
 */
const RETRYABLE_CONSTRAINTS: ReadonlySet<string> = new Set([
  UniqueConstraint.TransactionIdempotencyKey,
  UniqueConstraint.TransactionExternalId,
  UniqueConstraint.SingleReversal,
]);

/**
 * Submete uma operação de aposta. Mesmo caso de uso para HTTP e SQS.
 *
 * Fluxo: (inbox, só no SQS) → lock da wallet → idempotência → decisão e
 * gravação (WagerTransactionProcessor) → (inbox processada). Tudo numa
 * transação SQL.
 */
export class SubmitWagerTransactionUseCase {
  private readonly processor: WagerTransactionProcessor;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: WageringMetrics,
  ) {
    this.processor = new WagerTransactionProcessor(ids);
  }

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

    // Primeiro passo no SQS: a inbox deduplica por (consumerName, messageId).
    if (command.inbox) {
      const duplicate = await this.registerInbox(repositories, command.inbox, now);
      if (duplicate) {
        return this.replayDuplicateMessage(repositories, transaction, duplicate, command.inbox);
      }
    }

    const result = await this.processLocked(repositories, transaction, command, now);

    if (command.inbox) {
      await repositories.inbox.markProcessed(
        command.inbox.consumerName,
        command.inbox.messageId,
        now,
      );
    }
    return result;
  }

  private async processLocked(
    repositories: TransactionalRepositories,
    transaction: WagerTransaction,
    command: SubmitWagerTransactionCommand,
    now: Date,
  ): Promise<SubmitWagerTransactionResult> {
    // A partir daqui nenhuma outra execução mexe nesta wallet até o commit (F1).
    const wallet = await repositories.wallets.lockById(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`Wallet ${command.walletId} não encontrada`);
    }

    const replay = await this.checkIdempotency(repositories, transaction);
    if (replay) {
      return replay;
    }

    return this.processor.process({
      repositories,
      transaction,
      wallet,
      now,
      isNew: true,
      save: (saved) => repositories.transactions.insert(saved),
      eventContext: () => ({
        eventId: this.ids.next(),
        correlationId: command.correlationId,
        ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
        occurredAt: now,
      }),
    });
  }

  /** `undefined` se inseriu; senão, a mensagem já registrada. */
  private async registerInbox(
    { inbox }: TransactionalRepositories,
    receipt: InboxReceipt,
    now: Date,
  ): Promise<InboxMessage | undefined> {
    const inserted = await inbox.insertIfAbsent(
      InboxMessage.receive({ ...receipt, receivedAt: now }),
    );
    if (inserted) {
      return undefined;
    }
    const existing = await inbox.findByKey(receipt.consumerName, receipt.messageId);
    if (!existing) {
      throw new Error(`Mensagem ${receipt.messageId} duplicada sem registro na inbox`);
    }
    return existing;
  }

  /** Mensagem já processada: devolve o resultado original pela idempotency key. */
  private async replayDuplicateMessage(
    { transactions }: TransactionalRepositories,
    transaction: WagerTransaction,
    duplicate: InboxMessage,
    receipt: InboxReceipt,
  ): Promise<SubmitWagerTransactionResult> {
    const original = await transactions.findByIdempotencyKey(
      transaction.providerId,
      transaction.idempotencyKey,
    );
    const payloadMismatch = duplicate.payloadHash !== receipt.payloadHash;
    if (!original) {
      if (payloadMismatch) {
        throw new DuplicateMessageError(
          `Mensagem ${duplicate.messageId} repetida com outro corpo, sem transação para repetir`,
        );
      }
      // A inbox e a transação são gravadas juntas; uma sem a outra é anomalia.
      throw new Error(`Mensagem ${duplicate.messageId} na inbox sem transação correspondente`);
    }
    return { ...toResult(original, true), duplicateMessage: { payloadMismatch } };
  }

  /** Replay com o resultado original, ou conflito. */
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
