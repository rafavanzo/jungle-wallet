/**
 * Motivos de rejeição ou falha persistidos na transação e devolvidos ao
 * provedor. Estáveis e legíveis por máquina: não renomeie um código existente.
 *
 * Erros de formato (INVALID_MONEY, INVALID_AMOUNT, referência ausente) não
 * estão aqui: eles não geram transação persistida e viram um 400 direto.
 */
export enum FailureCode {
  /** BET sem saldo suficiente. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** ROLLBACK que deixaria o saldo negativo. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Referência não encontrada após esgotar as tentativas. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência de outro provider, player, wallet, moeda ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Tipo de referência não permitido para o kind. */
  ReferenceInvalidKind = 'REFERENCE_INVALID_KIND',
  /** A referência foi REJECTED ou FAILED. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** A referência já foi revertida. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Valor da reversão diferente do valor da referência. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Moeda da operação diferente da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** A wallet não pertence ao player informado. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Um crédito estouraria o limite de valor suportado. */
  AmountOutOfRange = 'AMOUNT_OUT_OF_RANGE',
  /** Erro permanente de infraestrutura (transação FAILED). */
  ProcessingFailed = 'PROCESSING_FAILED',
}
