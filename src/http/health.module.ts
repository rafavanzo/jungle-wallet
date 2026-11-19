import { Module } from '@nestjs/common';

import { createSqsClient, readSqsSettings } from '../infra/messaging/sqs-event-publisher.js';
import { HEALTH_SQS_CLIENT, HEALTH_SQS_QUEUE_NAME, HealthController } from './health.controller.js';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: HEALTH_SQS_CLIENT, useFactory: () => createSqsClient(readSqsSettings(), 1_000) },
    {
      provide: HEALTH_SQS_QUEUE_NAME,
      useFactory: () => process.env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo',
    },
  ],
})
export class HealthModule {}
