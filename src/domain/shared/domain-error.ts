/**
 * Todos os códigos de erro do domínio, num lugar só. Uma classe de erro com um
 * código fora desta lista não compila; e a camada HTTP é obrigada (pelo tipo)
 * a mapear cada código daqui para um status.
 */
export type DomainErrorCode =
  | 'INVALID_MONEY'
  | 'INVALID_AMOUNT'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'CURRENCY_MISMATCH'
  | 'INSUFFICIENT_FUNDS'
  | 'UNBALANCED_LEDGER_ENTRY'
  | 'INVALID_TRANSACTION_STATE'
  | 'MISSING_REFERENCE'
  | 'UNEXPECTED_REFERENCE'
  | 'SELF_REFERENCE'
  | 'RESERVED_PROVIDER_ID'
  | 'UNSUPPORTED_TRANSACTION_KIND'
  | 'INVALID_MESSAGE_STATE';

/**
 * Base dos erros de regra de negócio.
 *
 * `code` é estável e legível por máquina: a camada HTTP e os eventos de falha
 * traduzem a partir dele, nunca a partir da mensagem.
 */
export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  override readonly code = 'INVALID_MONEY';
}

/**
 * Valor bem formado, mas não permitido para a operação: débito ou crédito de
 * zero ou negativo, saldo inicial negativo. Formato inválido é INVALID_MONEY.
 */
export class InvalidAmountError extends DomainError {
  override readonly code = 'INVALID_AMOUNT';
}

export class MoneyOverflowError extends DomainError {
  override readonly code = 'AMOUNT_OUT_OF_RANGE';
}

export class CurrencyMismatchError extends DomainError {
  override readonly code = 'CURRENCY_MISMATCH';
}
