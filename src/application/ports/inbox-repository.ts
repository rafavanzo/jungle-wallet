import type { InboxMessage } from '../../domain/messaging/inbox-message.js';

export interface InboxRepository {
  /**
   * Insere se (consumerName, messageId) ainda não existe, de forma atômica no
   * banco. `false` significa mensagem duplicada. Se outra transação estiver
   * inserindo a mesma chave, espera o commit dela e então devolve `false`.
   */
  insertIfAbsent(message: InboxMessage): Promise<boolean>;
  findByKey(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  /** Grava processed_at no fim da mesma transação que processou a mensagem. */
  markProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;
}
