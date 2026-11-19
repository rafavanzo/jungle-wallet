import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';

import { createHttpApp } from '../../src/http/create-http-app.js';
import { openTestDatabase, type TestDatabase } from '../integration/helpers/database.js';

let db: TestDatabase;
let app: INestApplication;
let baseUrl: string;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  // Aplica as migrations no banco de teste e aponta a aplicação para ele.
  db = await openTestDatabase();
  process.env.DATABASE_URL = process.env.DATABASE_TEST_URL;

  // A mesma montagem do main.ts (middleware de correlação antes do parser de JSON).
  app = await createHttpApp({ logger: false });
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
  await db.close();
  process.env.DATABASE_URL = originalDatabaseUrl;
});

const unique = (prefix: string): string => `${prefix}-${Bun.randomUUIDv7()}`;
const brl = (amount: string) => ({ amount, currency: 'BRL' });

interface Reply {
  status: number;
  headers: Headers;
  body: any;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body:
      options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

async function createWallet(amount = '1000.00') {
  const reply = await call('POST', '/wallets', {
    body: { playerId: unique('player'), initialBalance: brl(amount) },
  });
  expect(reply.status).toBe(201);
  return reply.body as { id: string; playerId: string };
}

function transactionBody(wallet: { id: string; playerId: string }, overrides: object = {}) {
  return {
    providerId: 'provider-a',
    externalTransactionId: unique('transaction'),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('25.00'),
    ...overrides,
  };
}

const submit = (body: object, idempotencyKey: string = unique('idem')) =>
  call('POST', '/wagering/transactions', {
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  });

describe('API HTTP', () => {
  describe('POST /wallets', () => {
    it('201 com o formato da seção 9; duplicada é 409', async () => {
      const playerId = unique('player');
      const body = { playerId, initialBalance: brl('1000.00') };

      const created = await call('POST', '/wallets', { body });
      const duplicate = await call('POST', '/wallets', { body });

      expect(created.status).toBe(201);
      expect(created.body).toEqual({
        id: expect.any(String),
        playerId,
        balance: brl('1000.00'),
        version: 1,
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('WALLET_ALREADY_EXISTS');
    });
  });

  describe('POST /wagering/transactions', () => {
    it('sem Idempotency-Key é 400 MISSING_IDEMPOTENCY_KEY', async () => {
      const wallet = await createWallet();

      const reply = await call('POST', '/wagering/transactions', { body: transactionBody(wallet) });

      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe('MISSING_IDEMPOTENCY_KEY');
    });

    it('amount numérico é 400', async () => {
      const wallet = await createWallet();

      const reply = await submit(
        transactionBody(wallet, { money: { amount: 25.5, currency: 'BRL' } }),
      );

      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('JSON malformado é 400 e a resposta ainda traz o correlation id', async () => {
      const reply = await call('POST', '/wagering/transactions', {
        rawBody: '{"providerId":',
        headers: { 'Idempotency-Key': unique('idem'), 'X-Correlation-Id': 'corr-malformed' },
      });

      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe('VALIDATION_ERROR');
      expect(reply.headers.get('x-correlation-id')).toBe('corr-malformed');
      expect(reply.body.correlationId).toBe('corr-malformed');
    });

    it('BET é 201; o replay idêntico é 200 com idempotentReplay e o resto igual', async () => {
      const wallet = await createWallet('1000.00');
      const body = transactionBody(wallet);
      const key = unique('idem');

      const first = await submit(body, key);
      const replay = await submit(body, key);

      expect(first.status).toBe(201);
      expect(first.body).toEqual({
        transactionId: expect.any(String),
        status: 'PROCESSED',
        balance: brl('975.00'),
        idempotentReplay: false,
      });
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    });

    it('campos desconhecidos são ignorados e não mudam o hash (tolerant reader)', async () => {
      const wallet = await createWallet();
      const body = transactionBody(wallet);
      const key = unique('idem');

      const first = await submit(body, key);
      const replay = await submit({ ...body, extraField: 'ignorado' }, key);

      expect(first.status).toBe(201);
      expect(replay.status).toBe(200);
      expect(replay.body.idempotentReplay).toBe(true);
    });

    it('mesma chave com payload diferente é 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const wallet = await createWallet();
      const key = unique('idem');
      const body = transactionBody(wallet);
      await submit(body, key);

      const reply = await submit({ ...body, money: brl('26.00') }, key);

      expect(reply.status).toBe(409);
      expect(reply.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('sem saldo é 422 com INSUFFICIENT_FUNDS; o replay também é 422', async () => {
      const wallet = await createWallet('10.00');
      const body = transactionBody(wallet, { money: brl('10.01') });
      const key = unique('idem');

      const reply = await submit(body, key);
      const replay = await submit(body, key);

      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS',
        balance: brl('10.00'),
        idempotentReplay: false,
      });
      expect(replay.status).toBe(422);
      expect(replay.body).toEqual({ ...reply.body, idempotentReplay: true });
    });

    it('REFUND sem o BET é 202 PENDING_REFERENCE', async () => {
      const wallet = await createWallet();

      const reply = await submit(
        transactionBody(wallet, {
          kind: 'REFUND',
          referenceExternalTransactionId: unique('missing-bet'),
        }),
      );

      expect(reply.status).toBe(202);
      expect(reply.body).toMatchObject({ status: 'PENDING_REFERENCE', idempotentReplay: false });
    });

    it('OPENING pela API é 400', async () => {
      const wallet = await createWallet();

      const reply = await submit(transactionBody(wallet, { kind: 'OPENING' }));

      expect(reply.status).toBe(400);
    });
  });

  describe('GET /wallets/:walletId', () => {
    it('200 para wallet existente, 400 para id não UUID e 404 para inexistente', async () => {
      const wallet = await createWallet('50.00');

      const found = await call('GET', `/wallets/${wallet.id}`);
      const invalid = await call('GET', '/wallets/not-a-uuid');
      const missing = await call('GET', `/wallets/${Bun.randomUUIDv7()}`);

      expect(found.status).toBe(200);
      expect(found.body).toEqual({
        id: wallet.id,
        playerId: wallet.playerId,
        balance: brl('50.00'),
        version: 1,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('WALLET_NOT_FOUND');
    });
  });

  describe('GET /wallets/:walletId/ledger', () => {
    it('pagina com cursor: 2 itens com nextCursor, depois o restante com nextCursor null', async () => {
      const wallet = await createWallet('100.00');
      await submit(transactionBody(wallet, { money: brl('10.00') }));
      await submit(transactionBody(wallet, { money: brl('20.00') }));

      const firstPage = await call('GET', `/wallets/${wallet.id}/ledger?limit=2`);
      const secondPage = await call(
        'GET',
        `/wallets/${wallet.id}/ledger?limit=2&cursor=${firstPage.body.nextCursor}`,
      );

      expect(firstPage.status).toBe(200);
      expect(firstPage.body.items.map((item: any) => item.balanceAfter.amount)).toEqual([
        '100.00',
        '90.00',
      ]);
      expect(typeof firstPage.body.nextCursor).toBe('string');
      expect(secondPage.status).toBe(200);
      expect(secondPage.body.items.map((item: any) => item.balanceAfter.amount)).toEqual(['70.00']);
      expect(secondPage.body.nextCursor).toBeNull();
    });

    it('cursor inválido é 400 INVALID_CURSOR; limit fora de 1..100 é 400', async () => {
      const wallet = await createWallet();

      const badCursor = await call('GET', `/wallets/${wallet.id}/ledger?cursor=lixo`);
      const badLimit = await call('GET', `/wallets/${wallet.id}/ledger?limit=101`);

      expect(badCursor.status).toBe(400);
      expect(badCursor.body.error.code).toBe('INVALID_CURSOR');
      expect(badLimit.status).toBe(400);
      expect(badLimit.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET da transação', () => {
    it('pelo id e pelo providerId + externalTransactionId, sem expor o payloadHash', async () => {
      const wallet = await createWallet();
      const body = transactionBody(wallet);
      const submitted = await submit(body);

      const byId = await call('GET', `/wagering/transactions/${submitted.body.transactionId}`);
      const byExternal = await call(
        'GET',
        `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
      );

      expect(byId.status).toBe(200);
      expect(byId.body).toMatchObject({
        id: submitted.body.transactionId,
        providerId: 'provider-a',
        externalTransactionId: body.externalTransactionId,
        kind: 'BET',
        money: brl('25.00'),
        status: 'PROCESSED',
        resultingBalance: brl('975.00'),
        failureCode: null,
      });
      expect(byId.body).not.toHaveProperty('payloadHash');
      expect(byExternal.status).toBe(200);
      expect(byExternal.body).toEqual(byId.body);
    });

    it('transação inexistente é 404 TRANSACTION_NOT_FOUND', async () => {
      const reply = await call('GET', `/wagering/transactions/${Bun.randomUUIDv7()}`);

      expect(reply.status).toBe(404);
      expect(reply.body.error.code).toBe('TRANSACTION_NOT_FOUND');
    });
  });

  describe('X-Correlation-Id', () => {
    it('o id enviado volta no header e no corpo de erro', async () => {
      const reply = await call('GET', `/wallets/${Bun.randomUUIDv7()}`, {
        headers: { 'X-Correlation-Id': 'corr-e2e-123' },
      });

      expect(reply.headers.get('x-correlation-id')).toBe('corr-e2e-123');
      expect(reply.body.correlationId).toBe('corr-e2e-123');
    });

    it('sem o header, um id é gerado e devolvido', async () => {
      const wallet = await createWallet();

      const reply = await call('GET', `/wallets/${wallet.id}`);

      expect(reply.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('um id inválido é substituído por um gerado e não impede a aposta', async () => {
      const wallet = await createWallet();

      const reply = await call('POST', '/wagering/transactions', {
        body: transactionBody(wallet),
        headers: { 'Idempotency-Key': unique('idem'), 'X-Correlation-Id': 'x'.repeat(200) },
      });

      expect(reply.status).toBe(201);
      expect(reply.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('rota inexistente também recebe correlation id', async () => {
      const reply = await call('GET', '/rota-que-nao-existe', {
        headers: { 'X-Correlation-Id': 'corr-404' },
      });

      expect(reply.status).toBe(404);
      expect(reply.body).toEqual({
        error: { code: 'ROUTE_NOT_FOUND', message: expect.any(String) },
        correlationId: 'corr-404',
      });
    });
  });
});
