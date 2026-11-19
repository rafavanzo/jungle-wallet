import { InvalidCursorError } from '../errors/application-errors.js';

const CURSOR_VERSION = 1;

interface LedgerCursorV1 {
  v: typeof CURSOR_VERSION;
  afterId: string;
}

/**
 * Cursor opaco do ledger: base64url de `{ v: 1, afterId }`.
 *
 * Estável porque o id é UUID v7 (ordenável por tempo) e o ledger só recebe
 * inserts: lançamentos novos não mudam as páginas já lidas. Opaco porque o
 * cliente não precisa entendê-lo; o `v` permite mudar o formato depois.
 */
export function encodeLedgerCursor(afterId: string): string {
  const cursor: LedgerCursorV1 = { v: CURSOR_VERSION, afterId };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeLedgerCursor(cursor: string): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError('Cursor de paginação inválido');
  }

  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    (decoded as { v?: unknown }).v !== CURSOR_VERSION ||
    typeof (decoded as { afterId?: unknown }).afterId !== 'string' ||
    !UUID_PATTERN.test((decoded as { afterId: string }).afterId)
  ) {
    throw new InvalidCursorError('Cursor de paginação inválido');
  }
  return (decoded as LedgerCursorV1).afterId;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
