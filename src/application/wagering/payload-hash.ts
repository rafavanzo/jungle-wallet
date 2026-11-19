import { createHash } from 'node:crypto';

import { Money, type MoneyProps } from '../../domain/shared/money.js';
import type { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind.js';

/** Campos de negócio de uma operação de aposta, iguais no HTTP e no SQS. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string | null;
}

export const PAYLOAD_HASH_PREFIX = 'sha256-v1:';

/**
 * Hash do conteúdo de negócio de uma operação, para detectar uma idempotency
 * key reutilizada com outro payload.
 *
 * Algoritmo (v1):
 * 1. Só os campos de `WagerPayload` entram. idempotencyKey, messageId, headers
 *    e demais metadados de transporte ficam de fora.
 * 2. Normalização: o amount passa por `Money.from(...).toString()` ("25" e
 *    "25.00" dão o mesmo hash); referência ausente, null ou undefined é omitida.
 * 3. JSON canônico: chaves ordenadas recursivamente, sem espaços, sem undefined.
 * 4. SHA-256 em hexadecimal, gravado como `sha256-v1:<hex>`.
 */
export function computePayloadHash(payload: WagerPayload): string {
  const money = Money.from(payload.money);
  const reference = payload.referenceExternalTransactionId ?? undefined;

  const businessFields = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: money.toString(), currency: money.currency },
    referenceExternalTransactionId: reference,
  };

  const digest = createHash('sha256').update(canonicalJson(businessFields), 'utf8').digest('hex');
  return `${PAYLOAD_HASH_PREFIX}${digest}`;
}

/** JSON com chaves ordenadas recursivamente e sem valores undefined. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, nested]) => [key, sortKeys(nested)]),
    );
  }
  return value;
}
