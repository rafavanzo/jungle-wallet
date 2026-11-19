import { z } from 'zod';

import { WagerTransactionKind } from '../domain/wagering/wager-transaction-kind.js';
import { moneySchema } from './money.contract.js';

/** Textos limitados: um payload gigante não chega ao banco. */
const text = () => z.string().min(1).max(128);

/**
 * Payload de uma operação de aposta, o mesmo para HTTP e SQS.
 *
 * Campos desconhecidos são ignorados (comportamento padrão do Zod), não
 * rejeitados: tolerant reader. Um provedor que mande um campo extra não quebra,
 * e o payloadHash usa só os campos conhecidos, então a idempotência não muda.
 */
export const wagerTransactionPayloadSchema = z.object({
  providerId: text(),
  externalTransactionId: text(),
  playerId: text(),
  walletId: z.uuid(),
  roundId: text(),
  gameId: text(),
  // OPENING é interno e não é aceito pela borda.
  kind: z.enum([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ]),
  money: moneySchema,
  referenceExternalTransactionId: text().nullish(),
});

export type WagerTransactionPayload = z.infer<typeof wagerTransactionPayloadSchema>;
