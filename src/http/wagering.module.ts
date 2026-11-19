import { Module } from '@nestjs/common';

import {
  NoopWageringMetrics,
  WAGERING_METRICS,
  type WageringMetrics,
} from '../application/metrics/wagering-metrics.js';
import { CLOCK, type Clock } from '../application/ports/clock.js';
import { ID_GENERATOR, type IdGenerator } from '../application/ports/id-generator.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../application/ports/unit-of-work.js';
import {
  GetTransactionByExternalIdQuery,
  GetTransactionByIdQuery,
} from '../application/queries/get-transaction.query.js';
import { GetWalletQuery } from '../application/queries/get-wallet.query.js';
import { ListWalletLedgerQuery } from '../application/queries/list-wallet-ledger.query.js';
import { SubmitWagerTransactionUseCase } from '../application/wagering/submit-wager-transaction.use-case.js';
import { OpenWalletUseCase } from '../application/wallets/open-wallet.use-case.js';
import { DatabaseModule } from '../infra/database/database.module.js';
import { ProviderAuthGuard } from './provider-auth.guard.js';
import { WageringController } from './wagering.controller.js';
import { WalletsController } from './wallets.controller.js';

/**
 * Monta os casos de uso (classes comuns, sem Nest) com as portas por token.
 * Os casos de uso não sabem que existe um container de injeção.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [WalletsController, WageringController],
  providers: [
    ProviderAuthGuard,
    { provide: WAGERING_METRICS, useClass: NoopWageringMetrics },
    {
      provide: OpenWalletUseCase,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
        new OpenWalletUseCase(uow, clock, ids),
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
    {
      provide: SubmitWagerTransactionUseCase,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: WageringMetrics) =>
        new SubmitWagerTransactionUseCase(uow, clock, ids, metrics),
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, WAGERING_METRICS],
    },
    {
      provide: GetWalletQuery,
      useFactory: (uow: UnitOfWork) => new GetWalletQuery(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: ListWalletLedgerQuery,
      useFactory: (uow: UnitOfWork) => new ListWalletLedgerQuery(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: GetTransactionByIdQuery,
      useFactory: (uow: UnitOfWork) => new GetTransactionByIdQuery(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: GetTransactionByExternalIdQuery,
      useFactory: (uow: UnitOfWork) => new GetTransactionByExternalIdQuery(uow),
      inject: [UNIT_OF_WORK],
    },
  ],
})
export class WageringModule {}
