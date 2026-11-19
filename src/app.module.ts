import { Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';

import { HttpExceptionFilter } from './http/http-exception.filter.js';
import { createValidationPipe } from './http/validation.js';
import { HealthModule } from './http/health.module.js';
import { MetricsModule } from './http/metrics.module.js';
import { WageringModule } from './http/wagering.module.js';
import { OutboxPublisherModule } from './workers/outbox-publisher.module.js';
import { PendingReferenceModule } from './workers/pending-reference.module.js';
import { WagerConsumerModule } from './workers/wager-consumer.module.js';

@Module({
  imports: [
    MetricsModule,
    HealthModule,
    WageringModule,
    OutboxPublisherModule,
    WagerConsumerModule,
    PendingReferenceModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule {}
