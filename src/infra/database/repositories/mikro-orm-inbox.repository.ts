import type { EntityManager } from '@mikro-orm/postgresql';

import type { InboxRepository } from '../../../application/ports/inbox-repository.js';
import type { InboxMessage } from '../../../domain/messaging/inbox-message.js';
import { InboxMessageMapper } from '../mappers/inbox-message.mapper.js';
import { InboxMessageRecord } from '../records/inbox-message.record.js';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * ON CONFLICT DO NOTHING resolve a duplicata no banco, de forma atômica. Um
   * SELECT antes do INSERT deixaria duas instâncias verem "não existe" ao mesmo
   * tempo.
   */
  async insertIfAbsent(message: InboxMessage): Promise<boolean> {
    const record = InboxMessageMapper.toRecord(message);
    const result = await this.em.execute<{ affectedRows: number }>(
      `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING`,
      [
        record.consumerName,
        record.messageId,
        record.payloadHash,
        record.receivedAt,
        record.processedAt,
      ],
      'run',
    );
    return result.affectedRows === 1;
  }

  async findByKey(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(
      InboxMessageRecord,
      { consumerName, messageId },
      { disableIdentityMap: true },
    );
    return record ? InboxMessageMapper.toDomain(record) : undefined;
  }
}
