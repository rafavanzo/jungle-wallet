/**
 * Erros que a persistência expõe para a aplicação, já traduzidos a partir do
 * driver. HTTP e SQS reagem a eles da mesma forma.
 */

/**
 * Nomes das garantias de unicidade do schema que a aplicação trata. São parte
 * do contrato com a migration: renomear uma constraint exige mudar aqui.
 */
export const UniqueConstraint = {
  WalletPlayerCurrency: 'ux_wallets_player_currency',
  TransactionIdempotencyKey: 'ux_wager_tx_idempotency',
  TransactionExternalId: 'ux_wager_tx_external',
  SingleReversal: 'ux_wager_tx_single_reversal',
} as const;

/** Violação de unicidade. O nome da constraint diz qual garantia foi acionada. */
export class UniqueViolationError extends Error {
  constructor(
    readonly constraint: string | undefined,
    options?: ErrorOptions,
  ) {
    super(`Violação de unicidade${constraint ? ` (${constraint})` : ''}`, options);
    this.name = 'UniqueViolationError';
  }
}

/**
 * Falha transitória de infraestrutura (lock timeout, deadlock, banco fora do
 * ar). A operação pode ser repetida depois: 503 no HTTP, sem ack no SQS.
 */
export class TransientInfrastructureError extends Error {
  constructor(
    message: string,
    /** Espera pelo lock esgotou o lock_timeout (métrica de conflitos de lock). */
    readonly lockTimeout: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'TransientInfrastructureError';
  }
}

/**
 * Um UPDATE com guarda (versão ou status anterior) não encontrou a linha no
 * estado esperado: outra execução alterou o registro antes.
 */
export class StaleUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleUpdateError';
  }
}
