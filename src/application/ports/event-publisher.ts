/** Evento pronto para sair do processo, sem nada do SDK da fila. */
export interface OutgoingEvent {
  /** Chave de deduplicação: estável entre republicações do mesmo evento. */
  eventId: string;
  /** Ordem garantida só dentro do grupo (a wallet). */
  groupId: string;
  body: string;
}

export interface EventPublisher {
  /** Resolve só depois que a fila confirmou o recebimento. */
  publish(event: OutgoingEvent): Promise<void>;
}

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
