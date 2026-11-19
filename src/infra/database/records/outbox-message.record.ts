import { EntitySchema } from '@mikro-orm/postgresql';

/** Espelho da tabela `outbox_messages`. O payload é o envelope do evento em jsonb. */
export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  publishedAt!: Date | null;
  lastError!: string | null;
}

export const OutboxMessageSchema = new EntitySchema({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'text' },
    eventType: { type: 'text' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'datetime', columnType: 'timestamptz' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', columnType: 'timestamptz' },
    publishedAt: { type: 'datetime', columnType: 'timestamptz', nullable: true },
    lastError: { type: 'text', nullable: true },
  },
});
