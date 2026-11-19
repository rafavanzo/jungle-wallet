import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { GetWalletQuery } from '../application/queries/get-wallet.query.js';
import { ListWalletLedgerQuery } from '../application/queries/list-wallet-ledger.query.js';
import type { LedgerPageView, WalletView } from '../application/queries/views.js';
import {
  type OpenWalletResult,
  OpenWalletUseCase,
} from '../application/wallets/open-wallet.use-case.js';
import {
  type ReconciliationResult,
  ReconcileWalletUseCase,
} from '../application/wallets/reconcile-wallet.use-case.js';
import { type OpenWalletPayload, openWalletPayloadSchema } from '../contracts/wallet.contract.js';
import { CorrelationId } from './correlation-id.js';
import { ProviderAuthGuard } from './provider-auth.guard.js';
import { type LedgerQuery, ledgerQuerySchema, uuidParam } from './request-schemas.js';

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWalletUseCase) private readonly openWallet: OpenWalletUseCase,
    @Inject(GetWalletQuery) private readonly getWallet: GetWalletQuery,
    @Inject(ListWalletLedgerQuery) private readonly listLedger: ListWalletLedgerQuery,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  private readonly logger = new Logger(WalletsController.name);

  @Post()
  open(
    @Body({ schema: openWalletPayloadSchema }) body: OpenWalletPayload,
    @CorrelationId() correlationId: string,
  ): Promise<OpenWalletResult> {
    return this.openWallet.execute({ ...body, correlationId });
  }

  @Get(':walletId')
  get(@Param('walletId', { schema: uuidParam }) walletId: string): Promise<WalletView> {
    return this.getWallet.execute(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId', { schema: uuidParam }) walletId: string,
    @Query({ schema: ledgerQuerySchema }) query: LedgerQuery,
  ): Promise<LedgerPageView> {
    return this.listLedger.execute({ walletId, cursor: query.cursor, limit: query.limit });
  }

  /** 200 com consistent true ou false; a divergência é logada e nunca corrigida. */
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(
    @Param('walletId', { schema: uuidParam }) walletId: string,
    @CorrelationId() correlationId: string,
  ): Promise<ReconciliationResult> {
    const result = await this.reconcileWallet.execute(walletId);
    if (!result.consistent) {
      this.logger.error({
        msg: 'Divergência de reconciliação',
        correlationId,
        walletId,
        storedBalance: result.storedBalance,
        calculatedBalance: result.calculatedBalance,
        difference: result.difference,
        checkedEntries: result.checkedEntries,
      });
    }
    return result;
  }
}
