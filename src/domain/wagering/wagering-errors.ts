import { DomainError } from '../shared/domain-error.js';

/**
 * Transição a partir de um estado que não a permite (por exemplo, a partir de
 * um estado terminal). É erro de programação, não caminho de negócio: não vira
 * failureCode para o provedor.
 */
export class InvalidTransactionStateError extends DomainError {
  override readonly code = 'INVALID_TRANSACTION_STATE';
}

/** REFUND ou ROLLBACK sem referência (regra 1). */
export class MissingReferenceError extends DomainError {
  override readonly code = 'MISSING_REFERENCE';
}

/** Referência informada num kind que não aceita referência (BET). */
export class UnexpectedReferenceError extends DomainError {
  override readonly code = 'UNEXPECTED_REFERENCE';
}

/** A transação referencia a si mesma. */
export class SelfReferenceError extends DomainError {
  override readonly code = 'SELF_REFERENCE';
}

/** providerId reservado para transações internas (OPENING). */
export class ReservedProviderIdError extends DomainError {
  override readonly code = 'RESERVED_PROVIDER_ID';
}

/** Kind não suportado pela operação (OPENING via create, direção de ledger de LOSS). */
export class UnsupportedTransactionKindError extends DomainError {
  override readonly code = 'UNSUPPORTED_TRANSACTION_KIND';
}
