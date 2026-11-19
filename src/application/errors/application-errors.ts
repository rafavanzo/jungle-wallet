/**
 * Erros que impedem um caso de uso de processar o comando. Rejeições de
 * negócio não estão aqui: elas são resultados persistidos, não exceções.
 * `code` é estável e legível por máquina, como nos erros de domínio.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

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

/** playerId vazio ou que não é string. */
export class InvalidPlayerIdError extends ApplicationError {
  override readonly code = 'INVALID_PLAYER_ID';
}

export type IdempotencyConflictCode = 'IDEMPOTENCY_KEY_REUSED' | 'EXTERNAL_TRANSACTION_ID_CONFLICT';

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
