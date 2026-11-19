import type { OutboxMessage } from '../../domain/messaging/outbox-message.js';

export interface OutboxRepository {
  insert(message: OutboxMessage): Promise<void>;
  findById(id: string): Promise<OutboxMessage | undefined>;
  /**
   * Trava até `limit` mensagens pendentes e vencidas, pulando as que outra
   * transação já travou. As travas duram até o fim da transação.
   */
  claimDue(limit: number): Promise<OutboxMessage[]>;
  /** Grava o resultado da tentativa (publicada ou reagendada) de uma mensagem ainda pendente. */
  update(message: OutboxMessage): Promise<void>;
}
