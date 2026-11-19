/**
 * Erros que a persistência expõe para a aplicação, já traduzidos a partir do
 * driver. HTTP e SQS reagem a eles da mesma forma.
 */

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
  constructor(message: string, options?: ErrorOptions) {
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
