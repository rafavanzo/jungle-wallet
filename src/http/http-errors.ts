/** Códigos de erro que só existem na borda HTTP. */
export type HttpErrorCode =
  | 'VALIDATION_ERROR'
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'ROUTE_NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  | 'TRANSIENT_INFRASTRUCTURE'
  | 'INTERNAL_ERROR';

/** Requisição inválida detectada na borda, antes de chegar ao caso de uso. */
export class HttpRequestError extends Error {
  constructor(
    readonly code: HttpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpRequestError';
  }
}
