import type { EntityManager, FilterQuery } from '@mikro-orm/postgresql';

import { StaleUpdateError } from '../../../application/ports/persistence-errors.js';
import type {
  ReferenceRetryCandidate,
  WagerTransactionRepository,
} from '../../../application/ports/wager-transaction-repository.js';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction.js';
import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status.js';
import { WagerTransactionMapper } from '../mappers/wager-transaction.mapper.js';
import { WagerTransactionRecord } from '../records/wager-transaction.record.js';

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ id });
  }

  findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ providerId, idempotencyKey });
  }

  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.findOneBy({ providerId, externalTransactionId });
  }

  async hasProcessedReversalOf(transactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId: transactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  /** Sem lock: o worker trava a wallet depois, transação por transação. */
  async findDueForReferenceRetry(now: Date, limit: number): Promise<ReferenceRetryCandidate[]> {
    const records = await this.em.find(
      WagerTransactionRecord,
      {
        status: WagerTransactionStatus.PendingReference,
        nextReferenceAttemptAt: { $lte: now },
      },
      {
        fields: ['id', 'walletId'],
        orderBy: { nextReferenceAttemptAt: 'asc' },
        limit,
        disableIdentityMap: true,
      },
    );
    return records.map((record) => ({ id: record.id, walletId: record.walletId }));
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, WagerTransactionMapper.toRecord(transaction));
  }

  async update(
    transaction: WagerTransaction,
    expectedPreviousStatus: WagerTransactionStatus,
  ): Promise<void> {
    const record = WagerTransactionMapper.toRecord(transaction);
    const affected = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id, status: expectedPreviousStatus },
      {
        status: record.status,
        referenceTransactionId: record.referenceTransactionId,
        failureCode: record.failureCode,
        resultingBalance: record.resultingBalance,
        resultingBalanceCurrency: record.resultingBalanceCurrency,
        referenceAttempts: record.referenceAttempts,
        nextReferenceAttemptAt: record.nextReferenceAttemptAt,
        processedAt: record.processedAt,
      },
    );
    if (affected === 0) {
      throw new StaleUpdateError(
        `Transação ${transaction.id} não está mais em ${expectedPreviousStatus}`,
      );
    }
  }

  private async findOneBy(
    where: FilterQuery<WagerTransactionRecord>,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, where, {
      disableIdentityMap: true,
    });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }
}
