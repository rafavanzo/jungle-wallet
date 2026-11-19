import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import {
  createSqsClient,
  readSqsSettings,
} from '../../../src/infra/messaging/sqs-event-publisher.js';

export interface ReceivedEvent {
  deliveries: number;
  groupId: string | undefined;
  body: Record<string, unknown>;
}

export interface EventsQueue {
  client: SQSClient;
  name: string;
  url: string;
  /**
   * Recebe e apaga mensagens até ver todos os eventIds esperados, e depois faz
   * mais uma rodada para pegar entregas duplicadas. Mensagens de outros testes
   * são apagadas e ignoradas.
   */
  receive(eventIds: Iterable<string>, timeoutMs?: number): Promise<Map<string, ReceivedEvent>>;
}

export async function openEventsQueue(): Promise<EventsQueue> {
  const client = createSqsClient(readSqsSettings());
  const name = process.env.SQS_EVENTS_QUEUE_NAME;
  if (!name) {
    throw new Error('Variável de ambiente SQS_EVENTS_QUEUE_NAME não definida');
  }
  const { QueueUrl: url } = await client.send(new GetQueueUrlCommand({ QueueName: name }));
  if (!url) {
    throw new Error(`Fila ${name} não encontrada (rode docker compose up sqs-init)`);
  }

  const receiveRound = async (expected: Set<string>, found: Map<string, ReceivedEvent>) => {
    const { Messages = [] } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['MessageGroupId'],
      }),
    );
    for (const message of Messages) {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: message.ReceiptHandle }),
      );
      const body = JSON.parse(message.Body ?? '{}') as Record<string, unknown>;
      const eventId = body.eventId as string;
      if (!expected.has(eventId)) {
        continue;
      }
      const previous = found.get(eventId);
      found.set(eventId, {
        deliveries: (previous?.deliveries ?? 0) + 1,
        groupId: message.Attributes?.MessageGroupId,
        body,
      });
    }
    return Messages.length;
  };

  return {
    client,
    name,
    url,
    async receive(eventIds, timeoutMs = 10_000) {
      const expected = new Set(eventIds);
      const found = new Map<string, ReceivedEvent>();
      const deadline = Date.now() + timeoutMs;
      while (found.size < expected.size && Date.now() < deadline) {
        await receiveRound(expected, found);
      }
      // Uma duplicata do mesmo grupo FIFO só é entregue depois que a primeira é apagada.
      while ((await receiveRound(expected, found)) > 0) {
        // Continua até a fila responder vazia.
      }
      return found;
    },
  };
}
