import { Module } from '@nestjs/common';

import { PublishOutboxBatchUseCase } from '../application/outbox/publish-outbox-batch.use-case.js';
import { CLOCK, type Clock } from '../application/ports/clock.js';
import { EVENT_PUBLISHER, type EventPublisher } from '../application/ports/event-publisher.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../application/ports/unit-of-work.js';
import { DatabaseModule } from '../infra/database/database.module.js';
import { MessagingModule } from '../infra/messaging/messaging.module.js';
import { OutboxPublisherWorker } from './outbox-publisher.worker.js';

/** O worker é montado sempre, mas só o main.ts o liga (papel "outbox"). */
@Module({
  imports: [DatabaseModule, MessagingModule],
  providers: [
    {
      provide: PublishOutboxBatchUseCase,
      useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock) =>
        new PublishOutboxBatchUseCase(uow, publisher, clock),
      inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK],
    },
    {
      provide: OutboxPublisherWorker,
      useFactory: (publishBatch: PublishOutboxBatchUseCase) =>
        new OutboxPublisherWorker(publishBatch),
      inject: [PublishOutboxBatchUseCase],
    },
  ],
  exports: [OutboxPublisherWorker],
})
export class OutboxPublisherModule {}
