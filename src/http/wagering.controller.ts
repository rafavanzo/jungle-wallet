import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Logger,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';

import {
  GetTransactionByExternalIdQuery,
  GetTransactionByIdQuery,
} from '../application/queries/get-transaction.query.js';
import type { TransactionView } from '../application/queries/views.js';
import { SubmitWagerTransactionUseCase } from '../application/wagering/submit-wager-transaction.use-case.js';
import type { SubmitWagerTransactionResult } from '../application/wagering/submit-wager-transaction.types.js';
import {
  type WagerTransactionPayload,
  wagerTransactionPayloadSchema,
} from '../contracts/wager-transaction.contract.js';
import { CorrelationId } from './correlation-id.js';
import { statusForResult } from './error-status-map.js';
import { ProviderAuthGuard } from './provider-auth.guard.js';
import { providerTextParam, requireIdempotencyKey, uuidParam } from './request-schemas.js';

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransactionUseCase)
    private readonly submitTransaction: SubmitWagerTransactionUseCase,
    @Inject(GetTransactionByIdQuery) private readonly getById: GetTransactionByIdQuery,
    @Inject(GetTransactionByExternalIdQuery)
    private readonly getByExternalId: GetTransactionByExternalIdQuery,
  ) {}

  private readonly logger = new Logger(WageringController.name);

  @Post('wagering/transactions')
  async submit(
    @Body({ schema: wagerTransactionPayloadSchema }) body: WagerTransactionPayload,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @CorrelationId() correlationId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmitWagerTransactionResult> {
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyHeader);
    const startedAt = performance.now();
    const result = await this.submitTransaction.execute({
      ...body,
      idempotencyKey,
      correlationId,
    });
    // Ids e resultado; sem o payload financeiro completo.
    this.logger.log({
      msg: 'wager_transaction',
      correlationId,
      transactionId: result.transactionId,
      walletId: body.walletId,
      providerId: body.providerId,
      kind: body.kind,
      status: result.status,
      failureCode: result.failureCode,
      idempotentReplay: result.idempotentReplay,
      latencyMs: Math.round(performance.now() - startedAt),
    });
    response.status(statusForResult(result));
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  getTransaction(
    @Param('transactionId', { schema: uuidParam }) transactionId: string,
  ): Promise<TransactionView> {
    return this.getById.execute(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getTransactionByExternalId(
    @Param('providerId', { schema: providerTextParam }) providerId: string,
    @Param('externalTransactionId', { schema: providerTextParam }) externalTransactionId: string,
  ): Promise<TransactionView> {
    return this.getByExternalId.execute(providerId, externalTransactionId);
  }
}
