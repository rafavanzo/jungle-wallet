import {
  TransientInfrastructureError,
  UniqueViolationError,
} from '../../application/ports/persistence-errors.js';
import { DomainError } from '../../domain/shared/domain-error.js';

const UNIQUE_VIOLATION = '23505';

/**
 * SQLSTATE de falhas que passam sozinhas: lock timeout, serialização, deadlock,
 * shutdown, banco ainda subindo e conexões demais.
 */
const TRANSIENT_SQLSTATES = new Set(['55P03', '40001', '40P01', '57P01', '57P03', '53300']);

/** Códigos de erro de rede do Node quando o banco está inacessível. */
const TRANSIENT_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);

interface DriverErrorShape {
  code?: unknown;
  constraint?: unknown;
}

/**
 * Converte erros do driver em erros da aplicação. Qualquer outro erro sobe
 * sem tradução e é tratado como bug (500).
 */
export function translateDatabaseError(error: unknown): unknown {
  if (!(error instanceof Error) || error instanceof DomainError) {
    return error;
  }

  const { code, constraint } = error as DriverErrorShape;
  if (typeof code !== 'string') {
    return error;
  }

  if (code === UNIQUE_VIOLATION) {
    return new UniqueViolationError(typeof constraint === 'string' ? constraint : undefined, {
      cause: error,
    });
  }

  if (TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || TRANSIENT_NETWORK_CODES.has(code)) {
    return new TransientInfrastructureError(`Falha transitória do banco (${code})`, {
      cause: error,
    });
  }

  return error;
}
