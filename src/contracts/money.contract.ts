import { z } from 'zod';

/**
 * Dinheiro na borda: `amount` é string (um number é rejeitado aqui mesmo). O
 * formato decimal e a moeda ISO-4217 são validados depois pelo `Money.from`.
 */
export const moneySchema = z.object({
  amount: z.string().max(32),
  currency: z.string().max(3),
});

export type MoneyContract = z.infer<typeof moneySchema>;
