import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

import type { EventPublisher, OutgoingEvent } from '../../application/ports/event-publisher.js';

/** Teto de uma chamada ao SQS: a transação do lote fica aberta enquanto ela dura. */
export const SQS_REQUEST_TIMEOUT_MS = 5_000;
const SQS_CONNECTION_TIMEOUT_MS = 2_000;

export interface SqsSettings {
  endpoint: string | undefined;
  region: string;
}

/**
 * Sem retry no SDK (maxAttempts 1): quem repete é a outbox, com backoff e
 * registro em last_error. Um retry escondido no SDK só alongaria a transação.
 */
export function createSqsClient({ endpoint, region }: SqsSettings): SQSClient {
  return new SQSClient({
    region,
    ...(endpoint ? { endpoint } : {}),
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: SQS_CONNECTION_TIMEOUT_MS,
      requestTimeout: SQS_REQUEST_TIMEOUT_MS,
    },
  });
}

export function readSqsSettings(): SqsSettings {
  return {
    endpoint: process.env.SQS_ENDPOINT || undefined,
    region: process.env.AWS_REGION || 'us-east-1',
  };
}

/** Publica numa fila FIFO. A URL é resolvida pelo nome na primeira publicação. */
export class SqsEventPublisher implements EventPublisher {
  private queueUrl: Promise<string> | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(event: OutgoingEvent): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        MessageBody: event.body,
        MessageGroupId: event.groupId,
        // A fila descarta reenvios do mesmo eventId dentro da janela de 5 minutos.
        MessageDeduplicationId: event.eventId,
      }),
    );
  }

  private resolveQueueUrl(): Promise<string> {
    if (!this.queueUrl) {
      const pending = this.client
        .send(new GetQueueUrlCommand({ QueueName: this.queueName }))
        .then(({ QueueUrl }) => {
          if (!QueueUrl) {
            throw new Error(`Fila ${this.queueName} sem URL`);
          }
          return QueueUrl;
        });
      // Falhou (SQS fora do ar): a próxima publicação tenta resolver de novo.
      pending.catch(() => {
        if (this.queueUrl === pending) {
          this.queueUrl = undefined;
        }
      });
      this.queueUrl = pending;
    }
    return this.queueUrl;
  }
}
