import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';
import type { Clock } from '../ports/clock.js';
import type { EventPublisher, OutgoingEvent } from '../ports/event-publisher.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

export const OUTBOX_BATCH_SIZE = 10;
const MAX_ERROR_LENGTH = 1_000;

export interface OutboxBatchResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Um ciclo do publisher, numa transação: trava um lote de mensagens vencidas,
 * publica uma a uma e grava o resultado de cada uma.
 *
 * A publicação acontece com as travas seguradas. Se o processo morrer no meio,
 * a conexão cai, o Postgres desfaz a transação e libera as travas: outra
 * instância republica o lote (at-least-once). O eventId é a chave de
 * deduplicação na fila e no consumidor, então a republicação é segura.
 *
 * Nunca publica antes do commit: a mensagem só existe na tabela depois que a
 * transação da operação financeira commitou.
 */
export class PublishOutboxBatchUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly batchSize: number = OUTBOX_BATCH_SIZE,
  ) {}

  execute(): Promise<OutboxBatchResult> {
    return this.uow.run(async ({ outbox }) => {
      const messages = await outbox.claimDue(this.batchSize);
      const result: OutboxBatchResult = { claimed: messages.length, published: 0, failed: 0 };

      // Em sequência: dentro do lote, a ordem de publicação é a de gravação.
      for (const message of messages) {
        try {
          await this.publisher.publish(toOutgoingEvent(message));
          message.markPublished(this.clock.now());
          result.published += 1;
        } catch (error) {
          message.scheduleRetry(this.clock.now(), describeError(error));
          result.failed += 1;
        }
        await outbox.update(message);
      }

      return result;
    });
  }
}

/** O grupo FIFO é a wallet: eventos da mesma wallet saem na ordem. */
function toOutgoingEvent(message: OutboxMessage): OutgoingEvent {
  const data = message.payload.data as { walletId?: unknown } | undefined;
  if (typeof data?.walletId !== 'string' || data.walletId === '') {
    throw new Error(`Evento ${message.id} (${message.eventType}) sem data.walletId`);
  }
  return {
    eventId: message.id,
    groupId: data.walletId,
    body: JSON.stringify(message.payload),
  };
}

function describeError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, MAX_ERROR_LENGTH);
}
