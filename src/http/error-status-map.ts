import type { ApplicationErrorCode } from '../application/errors/application-errors.js';
import type { SubmitWagerTransactionResult } from '../application/wagering/submit-wager-transaction.types.js';
import type { DomainErrorCode } from '../domain/shared/domain-error.js';
import type { FailureCode } from '../domain/wagering/failure-code.js';
import { WagerTransactionStatus } from '../domain/wagering/wager-transaction-status.js';
import type { HttpErrorCode } from './http-errors.js';

/** Todo código que a API pode devolver. */
export type ErrorCode = DomainErrorCode | ApplicationErrorCode | `${FailureCode}` | HttpErrorCode;

/**
 * Status HTTP de cada código, num mapa só, para todos os endpoints. Como é um
 * Record<ErrorCode, number>, um código novo sem entrada aqui não compila.
 *
 * Só o 503 significa "pode reenviar" (com a mesma Idempotency-Key).
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  // 400: payload inválido. Corrigir e não reenviar igual.
  VALIDATION_ERROR: 400,
  MISSING_IDEMPOTENCY_KEY: 400,
  INVALID_MONEY: 400,
  INVALID_AMOUNT: 400,
  MISSING_REFERENCE: 400,
  UNEXPECTED_REFERENCE: 400,
  SELF_REFERENCE: 400,
  UNSUPPORTED_TRANSACTION_KIND: 400,
  RESERVED_PROVIDER_ID: 400,
  INVALID_PLAYER_ID: 400,
  INVALID_CURSOR: 400,

  // 404: recurso inexistente.
  WALLET_NOT_FOUND: 404,
  TRANSACTION_NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,

  // 409: conflito. Não reenviar com a mesma chave.
  WALLET_ALREADY_EXISTS: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  EXTERNAL_TRANSACTION_ID_CONFLICT: 409,

  // 413: corpo grande demais.
  PAYLOAD_TOO_LARGE: 413,

  // 422: rejeição de negócio persistida. Definitiva.
  INSUFFICIENT_FUNDS: 422,
  REVERSAL_INSUFFICIENT_FUNDS: 422,
  REFERENCE_NOT_FOUND: 422,
  REFERENCE_MISMATCH: 422,
  REFERENCE_INVALID_KIND: 422,
  REFERENCE_NOT_PROCESSED: 422,
  REFERENCE_ALREADY_REVERSED: 422,
  REFERENCE_AMOUNT_MISMATCH: 422,
  CURRENCY_MISMATCH: 422,
  WALLET_PLAYER_MISMATCH: 422,
  AMOUNT_OUT_OF_RANGE: 422,
  PROCESSING_FAILED: 422,

  // 503: falha transitória. Reenviar com a mesma chave é seguro.
  TRANSIENT_INFRASTRUCTURE: 503,

  // 500: bug. Erros de programação do domínio também caem aqui.
  INTERNAL_ERROR: 500,
  INVALID_TRANSACTION_STATE: 500,
  UNBALANCED_LEDGER_ENTRY: 500,
  INVALID_MESSAGE_STATE: 500,
};

/**
 * Status de um resultado de submissão. O replay devolve o mesmo status da
 * resposta original, exceto PROCESSED, que vira 200 (nada foi criado agora).
 */
export function statusForResult(result: SubmitWagerTransactionResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
  }
}
