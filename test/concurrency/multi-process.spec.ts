import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { openTestDatabase, type TestDatabase } from '../integration/helpers/database.js';
import { assertLedgerConsistent } from '../integration/use-cases/helpers.js';
import {
  type ApiProcess,
  brl,
  CONCURRENCY_TEST_TIMEOUT_MS,
  countStatuses,
  movementCounts,
  spawnApiProcess,
  type WagerRequest,
  wagerRequest,
} from './helpers.js';

const INSTANCES = 3;

let db: TestDatabase;
const instances: ApiProcess[] = [];

beforeAll(async () => {
  // Migrations aplicadas antes de subir os processos, que só leem o schema.
  db = await openTestDatabase();
  const started = await Promise.allSettled(
    Array.from({ length: INSTANCES }, () => spawnApiProcess()),
  );
  for (const result of started) {
    if (result.status === 'fulfilled') {
      instances.push(result.value);
    }
  }
  const failure = started.find((result) => result.status === 'rejected');
  if (failure) {
    throw failure.reason;
  }
}, CONCURRENCY_TEST_TIMEOUT_MS);

// Roda mesmo se um teste ou o beforeAll falhar: nenhum processo fica órfão.
afterAll(async () => {
  await Promise.all(instances.map((instance) => instance.stop()));
  await db?.close();
});

/** Requisição i vai para a instância i % 3, todas disparadas de uma vez. */
const fireRoundRobin = (requests: readonly WagerRequest[]) =>
  Promise.all(
    requests.map(({ body, idempotencyKey }, index) =>
      instances[index % INSTANCES]!.client.submit(body, idempotencyKey),
    ),
  );

describe('Concorrência entre três processos da API', () => {
  it(
    'wallet com 30.00 recebe 60 apostas de 1.00 → 30 processadas, 30 rejeitadas',
    async () => {
      const wallet = await instances[0]!.client.createWallet('30.00');

      const replies = await fireRoundRobin(Array.from({ length: 60 }, () => wagerRequest(wallet)));

      expect(countStatuses(replies)).toEqual({ 201: 30, 422: 30 });
      for (const reply of replies.filter((reply) => reply.status === 422)) {
        expect(reply.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      }
      expect(await instances[1]!.client.balance(wallet.id)).toBe('0.00');
      expect(await movementCounts(db, wallet.id)).toEqual({ debits: 30, credits: 0 });
      await assertLedgerConsistent(db, wallet.id);
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  it(
    'a mesma aposta 30x espalhada pelas três instâncias → um único débito',
    async () => {
      const wallet = await instances[0]!.client.createWallet('100.00');
      const request = wagerRequest(wallet, { money: brl('5.00') });

      const replies = await fireRoundRobin(Array.from({ length: 30 }, () => request));

      expect(countStatuses(replies)).toEqual({ 201: 1, 200: 29 });
      const transactionIds = new Set(replies.map((reply) => reply.body.transactionId));
      expect(transactionIds.size).toBe(1);
      for (const reply of replies) {
        expect(reply.body.balance).toEqual(brl('95.00'));
      }
      expect(await instances[2]!.client.balance(wallet.id)).toBe('95.00');
      expect(await movementCounts(db, wallet.id)).toEqual({ debits: 1, credits: 0 });
      await assertLedgerConsistent(db, wallet.id);
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );
});
