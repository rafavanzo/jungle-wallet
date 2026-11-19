import { InboxMessage } from '../../../domain/messaging/inbox-message.js';
import type { InboxMessageRecord } from '../records/inbox-message.record.js';

export const InboxMessageMapper = {
  toDomain(record: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: record.receivedAt,
      processedAt: record.processedAt ?? undefined,
    });
  },

  toRecord(message: InboxMessage): InboxMessageRecord {
    return {
      consumerName: message.consumerName,
      messageId: message.messageId,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    };
  },
};
