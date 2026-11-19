import type { SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';

import { EVENT_PUBLISHER } from '../../application/ports/event-publisher.js';
import { createSqsClient, readSqsSettings, SqsEventPublisher } from './sqs-event-publisher.js';

const SQS_CLIENT = Symbol('SQS_CLIENT');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente ${name} não definida`);
  }
  return value;
}

/** Liga a porta EventPublisher ao SQS. O cliente é criado sem conectar. */
@Module({
  providers: [
    { provide: SQS_CLIENT, useFactory: () => createSqsClient(readSqsSettings()) },
    {
      provide: EVENT_PUBLISHER,
      useFactory: (client: SQSClient) =>
        new SqsEventPublisher(client, requireEnv('SQS_EVENTS_QUEUE_NAME')),
      inject: [SQS_CLIENT],
    },
  ],
  exports: [EVENT_PUBLISHER],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
