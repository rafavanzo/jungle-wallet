import { DomainError } from '../shared/domain-error.js';

/**
 * Transição inválida de uma mensagem (publicar duas vezes, reprocessar uma
 * mensagem já processada). É erro de programação, não caminho de negócio.
 */
export class InvalidMessageStateError extends DomainError {
  override readonly code = 'INVALID_MESSAGE_STATE';
}
