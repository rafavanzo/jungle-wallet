import { z } from 'zod';

import { HttpRequestError } from './http-errors.js';

/** Parâmetros de rota com id interno: um não-UUID é 400, não um 22P02 do banco (500). */
export const uuidParam = z.uuid();

export const providerTextParam = z.string().min(1).max(128);

const DEFAULT_LEDGER_LIMIT = 50;

/** Query do ledger. O limit chega como texto e é convertido explicitamente. */
export const ledgerQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z
    .string()
    .regex(/^\d{1,3}$/, 'limit deve ser um inteiro')
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .optional()
    .transform((limit) => limit ?? DEFAULT_LEDGER_LIMIT),
});

export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

/** ASCII visível, de 1 a 255 caracteres. */
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,255}$/;

export function requireIdempotencyKey(header: string | undefined): string {
  if (header === undefined || header === '') {
    throw new HttpRequestError('MISSING_IDEMPOTENCY_KEY', 'O header Idempotency-Key é obrigatório');
  }
  if (!IDEMPOTENCY_KEY.test(header)) {
    throw new HttpRequestError(
      'VALIDATION_ERROR',
      'Idempotency-Key deve ter de 1 a 255 caracteres ASCII visíveis',
    );
  }
  return header;
}
