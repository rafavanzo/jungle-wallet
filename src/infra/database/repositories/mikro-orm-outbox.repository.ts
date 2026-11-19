import { LockMode, raw } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import type { OutboxRepository } from '../../../application/ports/outbox-repository.js';
import { StaleUpdateError } from '../../../application/ports/persistence-errors.js';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
import { OutboxMessageMapper } from '../mappers/outbox-message.mapper.js';
import { OutboxMessageRecord } from '../records/outbox-message.record.js';

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageRecord, OutboxMessageMapper.toRecord(message));
  }

  async findById(id: string): Promise<OutboxMessage | undefined> {
    const record = await this.em.findOne(OutboxMessageRecord, { id }, { disableIdentityMap: true });
    return record ? OutboxMessageMapper.toDomain(record) : undefined;
  }

  /**
   * FOR UPDATE SKIP LOCKED: publishers concorrentes pegam lotes disjuntos, sem
   * esperar um pelo outro. O vencimento usa o relógio do banco (now()), o mesmo
   * para todas as instâncias. Empate de occurred_at (eventos da mesma transação)
   * desempata pelo id, que é UUID v7 gerado na ordem de gravação.
   */
  async claimDue(limit: number): Promise<OutboxMessage[]> {
    const records = await this.em.find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: raw('now()') } },
      {
        orderBy: { occurredAt: 'asc', id: 'asc' },
        limit,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        disableIdentityMap: true,
      },
    );
    return records.map((record) => OutboxMessageMapper.toDomain(record));
  }

  /** Só atualiza se ainda estiver pendente: nunca desfaz uma publicação registrada. */
  async update(message: OutboxMessage): Promise<void> {
    const affected = await this.em.nativeUpdate(
      OutboxMessageRecord,
      { id: message.id, publishedAt: null },
      {
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt,
        publishedAt: message.publishedAt ?? null,
        lastError: message.lastError ?? null,
      },
    );
    if (affected === 0) {
      throw new StaleUpdateError(`Mensagem ${message.id} da outbox não está mais pendente`);
    }
  }
}
