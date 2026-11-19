import type { EntityManager } from '@mikro-orm/postgresql';

import type { OutboxRepository } from '../../../application/ports/outbox-repository.js';
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
}
