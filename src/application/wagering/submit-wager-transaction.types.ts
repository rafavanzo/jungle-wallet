import type { MoneyProps } from '../../domain/shared/money.js';
import type { FailureCode } from '../../domain/wagering/failure-code.js';
import type { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status.js';
import type { WagerPayload } from './payload-hash.js';

/** Operação de um provedor, igual para HTTP e SQS. Chega já validada pela borda. */
export interface SubmitWagerTransactionCommand extends WagerPayload {
  idempotencyKey: string;
  correlationId: string;
  /** messageId no SQS; ausente no HTTP. */
  causationId?: string;
  /** Só no SQS: registro na inbox, primeiro passo da mesma transação SQL. */
  inbox?: InboxReceipt;
}

export interface InboxReceipt {
  consumerName: string;
  messageId: string;
  /** SHA-256 do corpo bruto da mensagem. */
  payloadHash: string;
}

/** Status que um resultado pode ter: a transação nunca fica PENDING depois do caso de uso. */
export type SubmitWagerStatus = Exclude<WagerTransactionStatus, WagerTransactionStatus.Pending>;

/**
 * Resultado explícito. Uma rejeição de negócio é um resultado (persistido e
 * auditável), não uma exceção. Quem traduz para HTTP ou ack/nack do SQS é o
 * adaptador de cada entrada.
 */
export interface SubmitWagerTransactionResult {
  transactionId: string;
  status: SubmitWagerStatus;
  /** Saldo observado ao finalizar; ausente enquanto a referência está pendente. */
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
  /** A messageId já estava na inbox; `payloadMismatch` se o corpo era outro. */
  duplicateMessage?: { payloadMismatch: boolean };
}
