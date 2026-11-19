import { z } from 'zod';

import { wagerTransactionPayloadSchema } from './wager-transaction.contract.js';

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

/**
 * Mensagem da fila de entrada (seção 10). `data` usa o mesmo schema do HTTP,
 * mais a idempotencyKey, que no HTTP vem no header.
 */
export const wagerTransactionRequestedSchema = z.object({
  messageId: z.string().min(1).max(128),
  type: z.literal(WAGER_TRANSACTION_REQUESTED),
  occurredAt: z.iso.datetime(),
  data: wagerTransactionPayloadSchema.extend({
    idempotencyKey: z.string().min(1).max(255),
  }),
});

export type WagerTransactionRequested = z.infer<typeof wagerTransactionRequestedSchema>;
