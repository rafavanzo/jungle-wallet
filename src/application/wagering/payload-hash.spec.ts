import { describe, expect, it } from 'bun:test';

import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind.js';
import { canonicalJson, computePayloadHash, type WagerPayload } from './payload-hash.js';

const payload: WagerPayload = {
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
  playerId: 'player-1',
  walletId: '0192f28f-0000-7000-8000-000000000001',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25', currency: 'BRL' },
};

describe('computePayloadHash', () => {
  it('produz exatamente o hash conhecido para um payload fixo', () => {
    expect(computePayloadHash(payload)).toBe(
      'sha256-v1:70607de8e6d519e0de482f027d4b6d41d484aebc7dfdba58bb3778aaf58bbc13',
    );
  });

  it('a ordem das chaves não muda o hash', () => {
    const reordered: WagerPayload = {
      money: { currency: 'BRL', amount: '25' },
      kind: WagerTransactionKind.Bet,
      gameId: 'game-1',
      roundId: 'round-1',
      walletId: '0192f28f-0000-7000-8000-000000000001',
      playerId: 'player-1',
      externalTransactionId: 'ext-1',
      providerId: 'provider-1',
    };

    expect(computePayloadHash(reordered)).toBe(computePayloadHash(payload));
  });

  it('"25" e "25.00" dão o mesmo hash', () => {
    const normalized = { ...payload, money: { amount: '25.00', currency: 'BRL' } };

    expect(computePayloadHash(normalized)).toBe(computePayloadHash(payload));
  });

  it('o idempotencyKey e outros metadados de transporte não influenciam', () => {
    const withTransport = { ...payload, idempotencyKey: 'idem-1', messageId: 'msg-1' };
    const otherTransport = { ...payload, idempotencyKey: 'idem-2', messageId: 'msg-2' };

    expect(computePayloadHash(withTransport)).toBe(computePayloadHash(otherTransport));
    expect(computePayloadHash(withTransport)).toBe(computePayloadHash(payload));
  });

  it('referência ausente, null e undefined dão o mesmo hash', () => {
    const absent = computePayloadHash(payload);

    expect(computePayloadHash({ ...payload, referenceExternalTransactionId: null })).toBe(absent);
    expect(computePayloadHash({ ...payload, referenceExternalTransactionId: undefined })).toBe(
      absent,
    );
  });

  it.each([
    ['kind', { kind: WagerTransactionKind.Win }],
    ['walletId', { walletId: '0192f28f-0000-7000-8000-000000000002' }],
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['referência', { referenceExternalTransactionId: 'ext-0' }],
  ])('mudar %s muda o hash', (_field, change) => {
    expect(computePayloadHash({ ...payload, ...change })).not.toBe(computePayloadHash(payload));
  });
});

describe('canonicalJson', () => {
  it('ordena as chaves recursivamente e remove undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});
