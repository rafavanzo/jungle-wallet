import { copyDate } from '../shared/copy-date.js';
import { deepFreeze } from '../shared/deep-freeze.js';

/** Metadados de um evento, fornecidos pela aplicação (o domínio não gera ids nem lê o relógio). */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  data: T;
}

/** Envelope serializado gravado no payload da outbox. */
export type IntegrationEventEnvelope<T> = {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  /** ISO-8601. */
  occurredAt: string;
  version: number;
  data: T;
};

/**
 * Evento de integração. Cada evento concreto fixa `eventType` e `version` no
 * próprio tipo, então um nome errado é erro de compilação.
 *
 * `data` só contém valores JSON (Money entra como MoneyProps, nunca como
 * instância) e é congelado: o payload precisa ser estável e versionável.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly data: Readonly<T>;
  private readonly _occurredAt: Date;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) {
      this.causationId = props.causationId;
    }
    this._occurredAt = copyDate(props.occurredAt);
    this.data = deepFreeze(props.data);
  }

  get occurredAt(): Date {
    return copyDate(this._occurredAt);
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this._occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}
