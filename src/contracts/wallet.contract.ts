import { z } from 'zod';

import { moneySchema } from './money.contract.js';

/**
 * Criação de wallet. `initialBalance` é obrigatório porque carrega a moeda, que
 * faz parte da identidade da wallet (player + moeda). Sem saldo: "0.00".
 */
export const openWalletPayloadSchema = z.object({
  playerId: z.string().min(1).max(128),
  initialBalance: moneySchema,
});

export type OpenWalletPayload = z.infer<typeof openWalletPayloadSchema>;
