import { OutboxMessage } from '../../../domain/messaging/outbox-message.js';
import type { OutboxMessageRecord } from '../records/outbox-message.record.js';

export const OutboxMessageMapper = {
  toDomain(record: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt,
      publishedAt: record.publishedAt ?? undefined,
      lastError: record.lastError ?? undefined,
    });
  },

  toRecord(message: OutboxMessage): OutboxMessageRecord {
    return {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
      publishedAt: message.publishedAt ?? null,
      lastError: message.lastError ?? null,
    };
  },
};
