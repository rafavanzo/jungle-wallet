export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Não pode ser submetido pela API nem pela fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}
