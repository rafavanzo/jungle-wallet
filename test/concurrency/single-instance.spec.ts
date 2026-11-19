import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { INestApplication } from '@nestjs/common';

import { openTestDatabase, type TestDatabase } from '../integration/helpers/database.js';
import { assertLedgerConsistent } from '../integration/use-cases/helpers.js';
import {
  type ApiClient,
  brl,
  CONCURRENCY_TEST_TIMEOUT_MS,
  countStatuses,
  movementCounts,
  startInProcessApi,
  type WagerRequest,
  wagerRequest,
} from './helpers.js';

let db: TestDatabase;
let app: INestApplication;
let api: ApiClient;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  db = await openTestDatabase();
  ({ app, client: api } = await startInProcessApi());
}, CONCURRENCY_TEST_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
  await db.close();
  process.env.DATABASE_URL = originalDatabaseUrl;
});

/** Dispara todas de uma vez: nenhuma espera a anterior responder. */
const fire = (requests: readonly WagerRequest[]) =>
  Promise.all(requests.map(({ body, idempotencyKey }) => api.submit(body, idempotencyKey)));

// Os testes verificam invariantes, nunca a ordem de chegada.
describe('Concorrência numa instância', () => {
  it(
    'a mesma aposta 50x em paralelo: uma 201, 49 replays 200, um único DEBIT',
    async () => {
      const wallet = await api.createWallet('100.00');
      const request = wagerRequest(wallet, { money: brl('10.00') });

      const replies = await fire(Array.from({ length: 50 }, () => request));

      expect(countStatuses(replies)).toEqual({ 201: 1, 200: 49 });
      const created = replies.find((reply) => reply.status === 201)!;
      expect(created.body).toEqual({
        transactionId: expect.any(String),
        status: 'PROCESSED',
        balance: brl('90.00'),
        idempotentReplay: false,
      });
      for (const reply of replies.filter((reply) => reply.status === 200)) {
        expect(reply.body).toEqual({ ...created.body, idempotentReplay: true });
      }
      expect(await movementCounts(db, wallet.id)).toEqual({ debits: 1, credits: 0 });
      expect(await api.balance(wallet.id)).toBe('90.00');
      await assertLedgerConsistent(db, wallet.id);
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  it(
    'seção 8: saldo 100.00 e duas apostas de 80.00 simultâneas; o reenvio só repete',
    async () => {
      const wallet = await api.createWallet('100.00');
      const bets = [
        wagerRequest(wallet, { money: brl('80.00') }),
        wagerRequest(wallet, { money: brl('80.00') }),
      ];

      const first = await fire(bets);

      expect(countStatuses(first)).toEqual({ 201: 1, 422: 1 });
      expect(first.find((reply) => reply.status === 201)!.body).toEqual({
        transactionId: expect.any(String),
        status: 'PROCESSED',
        balance: brl('20.00'),
        idempotentReplay: false,
      });
      // Só é rejeitada depois que a outra debitou: o saldo visto é 20.00.
      expect(first.find((reply) => reply.status === 422)!.body).toEqual({
        transactionId: expect.any(String),
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: brl('20.00'),
        idempotentReplay: false,
      });
      expect(await api.balance(wallet.id)).toBe('20.00');
      expect(await movementCounts(db, wallet.id)).toEqual({ debits: 1, credits: 0 });

      const resent = await fire(bets);

      expect(countStatuses(resent)).toEqual({ 200: 1, 422: 1 });
      for (const [index, reply] of resent.entries()) {
        expect(reply.body).toEqual({ ...first[index]!.body, idempotentReplay: true });
      }
      expect(await api.balance(wallet.id)).toBe('20.00');
      expect(await movementCounts(db, wallet.id)).toEqual({ debits: 1, credits: 0 });
      await assertLedgerConsistent(db, wallet.id);
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  it(
    'hot wallet: saldo 50.00 e 100 apostas de 1.00 → 50 processadas e 50 sem saldo',
    async () => {
      const wallet = await api.createWallet('50.00');

      const replies = await fire(Array.from({ length: 100 }, () => wagerRequest(wallet)));

      expect(countStatuses(replies)).toEqual({ 201: 50, 422: 50 });
      const statuses = replies.map((reply) => `${reply.body.status}:${reply.body.failureCode}`);
      expect(statuses.filter((status) => status === 'PROCESSED:undefined')).toHaveLength(50);
      expect(statuses.filter((status) => status === 'REJECTED:INSUFFICIENT_FUNDS')).toHaveLength(
        50,
      );
      expect(await api.balance(wallet.id)).toBe('0.00');
      expect(await movementCounts(db, wallet.id)).toEqual({ debits: 50, credits: 0 });
      await assertLedgerConsistent(db, wallet.id);
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );

  it(
    'REFUND e ROLLBACK do mesmo BET ao mesmo tempo: um só reverte',
    async () => {
      const wallet = await api.createWallet('100.00');
      const bet = wagerRequest(wallet, { money: brl('25.00') });
      const placed = await api.submit(bet.body, bet.idempotencyKey);
      expect(placed.status).toBe(201);

      const reversal = (kind: string) =>
        wagerRequest(wallet, {
          kind,
          money: brl('25.00'),
          referenceExternalTransactionId: bet.body.externalTransactionId,
        });
      const replies = await fire([reversal('REFUND'), reversal('ROLLBACK')]);

      expect(countStatuses(replies)).toEqual({ 201: 1, 422: 1 });
      expect(replies.find((reply) => reply.status === 201)!.body).toMatchObject({
        status: 'PROCESSED',
        balance: brl('100.00'),
      });
      expect(replies.find((reply) => reply.status === 422)!.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'REFERENCE_ALREADY_REVERSED',
      });
      expect(await api.balance(wallet.id)).toBe('100.00');
      expect(await movementCounts(db, wallet.id)).toEqual({ debits: 1, credits: 1 });
      await assertLedgerConsistent(db, wallet.id);
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );
});
