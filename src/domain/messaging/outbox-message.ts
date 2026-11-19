import { copyDate } from '../shared/copy-date.js';
import { deepFreeze } from '../shared/deep-freeze.js';
import type { IntegrationEvent } from './integration-event.js';
import { InvalidMessageStateError } from './messaging-errors.js';

export const OUTBOX_RETRY_BASE_DELAY_MS = 1_000;
export const OUTBOX_RETRY_MAX_DELAY_MS = 5 * 60 * 1_000;

export interface OutboxMessageState {
  /** É o eventId do evento. */
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  publishedAt: Date | undefined;
  lastError: string | undefined;
}

/**
 * Evento já commitado, aguardando publicação. Gravado na mesma transação da
 * alteração financeira, então nunca é publicado antes do commit.
 *
 * Retry sem limite de tentativas: o evento é um fato confirmado e descartá-lo
 * seria perdê-lo. Falha prolongada é problema de infraestrutura, sinalizado pela
 * métrica de outbox lag. Só o intervalo é limitado (backoff até 5 minutos).
 */
export class OutboxMessage {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  private readonly _occurredAt: Date;
  private _attempts: number;
  private _nextAttemptAt: Date;
  private _publishedAt: Date | undefined;
  private _lastError: string | undefined;

  private constructor(state: OutboxMessageState) {
    this.id = state.id;
    this.aggregateId = state.aggregateId;
    this.eventType = state.eventType;
    this.payload = deepFreeze(state.payload);
    this._occurredAt = copyDate(state.occurredAt);
    this._attempts = state.attempts;
    this._nextAttemptAt = copyDate(state.nextAttemptAt);
    this._publishedAt = state.publishedAt && copyDate(state.publishedAt);
    this._lastError = state.lastError;
  }

  /** Pendente e com vencimento imediato. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      publishedAt: undefined,
      lastError: undefined,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get occurredAt(): Date {
    return copyDate(this._occurredAt);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return copyDate(this._nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt && copyDate(this._publishedAt);
  }

  /** Diagnóstico da última falha de publicação. */
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && now.getTime() >= this._nextAttemptAt.getTime();
  }

  markPublished(at: Date): void {
    this.assertPending('markPublished');
    this._publishedAt = copyDate(at);
  }

  /** Incrementa as tentativas e agenda a próxima: 2s, 4s, 8s, ... até 5 minutos. */
  scheduleRetry(now: Date, error: string): void {
    this.assertPending('scheduleRetry');
    this._attempts += 1;
    const delayMs = Math.min(
      OUTBOX_RETRY_BASE_DELAY_MS * 2 ** this._attempts,
      OUTBOX_RETRY_MAX_DELAY_MS,
    );
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
    this._lastError = error;
  }

  private assertPending(operation: string): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(
        `${operation} inválido: a mensagem ${this.id} já foi publicada`,
      );
    }
  }
}
