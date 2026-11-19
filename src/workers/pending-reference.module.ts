import { Module } from '@nestjs/common';

import { CLOCK, type Clock } from '../application/ports/clock.js';
import { ID_GENERATOR, type IdGenerator } from '../application/ports/id-generator.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../application/ports/unit-of-work.js';
import { RetryPendingReferencesUseCase } from '../application/wagering/retry-pending-references.use-case.js';
import { DatabaseModule } from '../infra/database/database.module.js';
import { PendingReferenceWorker } from './pending-reference.worker.js';

/** O worker é montado sempre, mas só o main.ts o liga (papel "pending"). */
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: RetryPendingReferencesUseCase,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new RetryPendingReferencesUseCase(uow, clock, ids),
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
    {
      provide: PendingReferenceWorker,
      useFactory: (retry: RetryPendingReferencesUseCase) => new PendingReferenceWorker(retry),
      inject: [RetryPendingReferencesUseCase],
    },
  ],
  exports: [PendingReferenceWorker],
})
export class PendingReferenceModule {}
