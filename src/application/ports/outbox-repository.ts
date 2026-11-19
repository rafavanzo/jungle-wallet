import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
  findById(id: string): Promise<OutboxMessage | undefined>;
}
