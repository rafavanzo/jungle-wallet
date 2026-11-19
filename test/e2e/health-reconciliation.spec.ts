import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';

import { createHttpApp } from '../../src/http/create-http-app.js';
import { openTestDatabase, type TestDatabase } from '../integration/helpers/database.js';

let db: TestDatabase;
let app: INestApplication;
let baseUrl: string;
const originalDatabaseUrl = process.env.DATABASE_URL;

async function startApp(): Promise<{ app: INestApplication; baseUrl: string }> {
  const started = await createHttpApp({ logger: false });
  await started.listen(0);
  const { port } = started.getHttpServer().address() as AddressInfo;
  return { app: started, baseUrl: `http://127.0.0.1:${port}` };
}

beforeAll(async () => {
  db = await openTestDatabase();
  process.env.DATABASE_URL = process.env.DATABASE_TEST_URL;
  ({ app, baseUrl } = await startApp());
});

afterAll(async () => {
  await app.close();
  await db.close();
  process.env.DATABASE_URL = originalDatabaseUrl;
});

async function call(url: string, method = 'GET', body?: unknown) {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    correlationId: response.headers.get('x-correlation-id'),
    body: await response.json(),
  };
}

async function createWallet(amount: string) {
  const reply = await call(`${baseUrl}/wallets`, 'POST', {
    playerId: `player-${Bun.randomUUIDv7()}`,
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(reply.status).toBe(201);
  return reply.body as { id: string; playerId: string };
}

describe('Health', () => {
  it('GET /health/live → 200 com correlation id', async () => {
    const reply = await call(`${baseUrl}/health/live`);

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ status: 'ok' });
    expect(reply.correlationId).toBeTruthy();
  });

  it('GET /health/ready → 200 com Postgres e SQS no ar', async () => {
    const reply = await call(`${baseUrl}/health/ready`);

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  it('GET /health/ready → 503 com o SQS num endpoint inválido', async () => {
    const originalEndpoint = process.env.SQS_ENDPOINT;
    process.env.SQS_ENDPOINT = 'http://127.0.0.1:1';
    const broken = await startApp();
    process.env.SQS_ENDPOINT = originalEndpoint;
    try {
      const reply = await call(`${broken.baseUrl}/health/ready`);

      expect(reply.status).toBe(503);
      expect(reply.body).toEqual({
        status: 'unavailable',
        checks: { postgres: 'up', sqs: 'down' },
      });
    } finally {
      await broken.app.close();
    }
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  it('wallet consistente → consistent true e checkedEntries certo', async () => {
    const wallet = await createWallet('100.00');
    const bet = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': Bun.randomUUIDv7() },
      body: JSON.stringify({
        providerId: 'provider-reconciliation',
        externalTransactionId: Bun.randomUUIDv7(),
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      }),
    });
    expect(bet.status).toBe(201);

    const reply = await call(`${baseUrl}/wallets/${wallet.id}/reconciliation`, 'POST');

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '70.00', currency: 'BRL' },
      calculatedBalance: { amount: '70.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  it('divergência simulada → consistent false, difference 1.00 e saldo não alterado', async () => {
    const wallet = await createWallet('100.00');
    await db.execute('UPDATE wallets SET balance = balance + 1 WHERE id = ?', [wallet.id]);

    const reply = await call(`${baseUrl}/wallets/${wallet.id}/reconciliation`, 'POST');

    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      storedBalance: { amount: '101.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '1.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 1,
    });
    const [row] = await db.execute<{ balance: string }[]>(
      'SELECT balance::text AS balance FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(row!.balance).toBe('101.00');
  });

  it('GET /metrics expõe as métricas, com a divergência contada e o outbox lag', async () => {
    const response = await fetch(`${baseUrl}/metrics`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('wager_transactions_total{status="PROCESSED",kind="BET"} 1');
    expect(text).toContain('wallet_reconciliation_divergences_total 1');
    expect(text).toMatch(/^outbox_lag_seconds \d+(\.\d+)?$/m);
    expect(text).toContain('wager_processing_duration_seconds_bucket');
  });

  it('wallet inexistente → 404', async () => {
    const reply = await call(`${baseUrl}/wallets/${crypto.randomUUID()}/reconciliation`, 'POST');

    expect(reply.status).toBe(404);
    expect(reply.body.error.code).toBe('WALLET_NOT_FOUND');
  });
});
