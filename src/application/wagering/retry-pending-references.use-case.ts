import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status.js';
import type { Clock } from '../ports/clock.js';
import type { IdGenerator } from '../ports/id-generator.js';
import type { ReferenceRetryCandidate } from '../ports/wager-transaction-repository.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { WagerTransactionProcessor } from './wager-transaction-processor.js';

export const PENDING_REFERENCE_BATCH_SIZE = 10;

export type RetryOutcome =
  | WagerTransactionStatus.Processed
  | WagerTransactionStatus.Rejected
  | WagerTransactionStatus.PendingReference
  | 'SKIPPED';

export interface RetryBatchResult {
  candidates: number;
  outcomes: RetryOutcome[];
}

/**
 * Um ciclo do worker de referência pendente (seção 7.1).
 *
 * Busca candidatos sem lock. Cada um vai numa transação própria: lock da
 * wallet primeiro (a mesma ordem do caso de uso de entrada, então sem
 * deadlock), recarga da transação e a mesma decisão do caso de uso
 * (WagerTransactionProcessor). Dois workers no mesmo candidato se serializam no
 * lock da wallet; o segundo vê o status mudado e pula.
 */
export class RetryPendingReferencesUseCase {
  private readonly processor: WagerTransactionProcessor;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly batchSize: number = PENDING_REFERENCE_BATCH_SIZE,
  ) {
    this.processor = new WagerTransactionProcessor(ids);
  }

  async execute(): Promise<RetryBatchResult> {
    const candidates = await this.uow.run(({ transactions }) =>
      transactions.findDueForReferenceRetry(this.clock.now(), this.batchSize),
    );
    const outcomes: RetryOutcome[] = [];
    // Em sequência: um candidato com problema não impede os outros (o erro sobe no fim).
    let firstError: unknown;
    for (const candidate of candidates) {
      try {
        outcomes.push(await this.retry(candidate));
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
    return { candidates: candidates.length, outcomes };
  }

  private retry(candidate: ReferenceRetryCandidate): Promise<RetryOutcome> {
    return this.uow.run(async (repositories) => {
      const now = this.clock.now();
      const wallet = await repositories.wallets.lockById(candidate.walletId);
      const transaction = await repositories.transactions.findById(candidate.id);
      if (
        !wallet ||
        !transaction ||
        transaction.status !== WagerTransactionStatus.PendingReference ||
        !transaction.isDueForReferenceRetry(now)
      ) {
        return 'SKIPPED';
      }

      const result = await this.processor.process({
        repositories,
        transaction,
        wallet,
        now,
        isNew: false,
        save: (saved) =>
          repositories.transactions.update(saved, WagerTransactionStatus.PendingReference),
        // O correlationId original não é persistido; o id da transação liga os eventos.
        eventContext: () => ({
          eventId: this.ids.next(),
          correlationId: transaction.id,
          causationId: transaction.id,
          occurredAt: now,
        }),
      });
      return result.status as RetryOutcome;
    });
  }
}
