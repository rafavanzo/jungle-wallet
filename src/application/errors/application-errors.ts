export type IdempotencyConflictCode = 'IDEMPOTENCY_KEY_REUSED' | 'EXTERNAL_TRANSACTION_ID_CONFLICT';

/** Todos os códigos de erro da aplicação, num lugar só (ver DomainErrorCode). */
export type ApplicationErrorCode =
  | 'WALLET_NOT_FOUND'
  | 'WALLET_ALREADY_EXISTS'
  | 'INVALID_PLAYER_ID'
  | 'TRANSACTION_NOT_FOUND'
  | 'INVALID_CURSOR'
  | 'DUPLICATE_MESSAGE'
  | IdempotencyConflictCode;

/**
 * Erros que impedem um caso de uso de processar o comando. Rejeições de
 * negócio não estão aqui: elas são resultados persistidos, não exceções.
 * `code` é estável e legível por máquina, como nos erros de domínio.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: ApplicationErrorCode;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  override readonly code = 'WALLET_NOT_FOUND';
}

export class WalletAlreadyExistsError extends ApplicationError {
  override readonly code = 'WALLET_ALREADY_EXISTS';
}

export class InvalidPlayerIdError extends ApplicationError {
  override readonly code = 'INVALID_PLAYER_ID';
}

export class TransactionNotFoundError extends ApplicationError {
  override readonly code = 'TRANSACTION_NOT_FOUND';
}

export class InvalidCursorError extends ApplicationError {
  override readonly code = 'INVALID_CURSOR';
}

/**
 * messageId já registrada na inbox, com um corpo cuja idempotency key não tem
 * transação: não há resultado para repetir. O consumidor dá ack (duplicata).
 */
export class DuplicateMessageError extends ApplicationError {
  override readonly code = 'DUPLICATE_MESSAGE';
}

/**
 * A mesma idempotency key com outro payload, ou o mesmo id externo do provedor
 * já registrado com outra chave.
 */
export class IdempotencyConflictError extends ApplicationError {
  override readonly code: IdempotencyConflictCode;

  constructor(code: IdempotencyConflictCode, message: string) {
    super(message);
    this.code = code;
  }
}
