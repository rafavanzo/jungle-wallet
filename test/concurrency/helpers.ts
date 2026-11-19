import { expect } from 'bun:test';
import { createServer, type AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';

import { createHttpApp } from '../../src/http/create-http-app.js';
import type { TestDatabase } from '../integration/helpers/database.js';

export const CONCURRENCY_TEST_TIMEOUT_MS = 30_000;

export const unique = (prefix: string): string => `${prefix}-${Bun.randomUUIDv7()}`;
export const brl = (amount: string) => ({ amount, currency: 'BRL' });

export interface Reply {
  status: number;
  body: any;
}

export interface TestWallet {
  id: string;
  playerId: string;
}

export class ApiClient {
  constructor(readonly baseUrl: string) {}

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null } satisfies Reply;
  }

  async createWallet(amount: string): Promise<TestWallet> {
    const reply = await this.call('POST', '/wallets', {
      playerId: unique('player'),
      initialBalance: brl(amount),
    });
    expect(reply.status).toBe(201);
    return { id: reply.body.id, playerId: reply.body.playerId };
  }

  submit(body: object, idempotencyKey: string): Promise<Reply> {
    return this.call('POST', '/wagering/transactions', body, { 'Idempotency-Key': idempotencyKey });
  }

  async balance(walletId: string): Promise<string> {
    const reply = await this.call('GET', `/wallets/${walletId}`);
    expect(reply.status).toBe(200);
    return reply.body.balance.amount;
  }
}

/** Uma requisição pronta para ser reenviada: corpo e idempotency key fixos. */
export interface WagerRequest {
  body: Record<string, unknown>;
  idempotencyKey: string;
}

export function wagerRequest(
  wallet: TestWallet,
  overrides: Record<string, unknown> = {},
): WagerRequest {
  return {
    idempotencyKey: unique('idem'),
    body: {
      providerId: 'provider-concurrency',
      externalTransactionId: unique('ext'),
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: brl('1.00'),
      ...overrides,
    },
  };
}

/** API dentro do processo do teste, com a mesma montagem do main.ts. */
export async function startInProcessApi(): Promise<{ client: ApiClient; app: INestApplication }> {
  process.env.DATABASE_URL = process.env.DATABASE_TEST_URL;
  const app = await createHttpApp({ logger: false });
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { client: new ApiClient(`http://127.0.0.1:${port}`), app };
}

/** Conta os status HTTP, para comparar com toEqual sem depender da ordem. */
export function countStatuses(replies: readonly Reply[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const reply of replies) {
    counts[reply.status] = (counts[reply.status] ?? 0) + 1;
  }
  return counts;
}

/** Lançamentos da wallet por direção, sem contar o CREDIT da abertura. */
export async function movementCounts(
  db: TestDatabase,
  walletId: string,
): Promise<{ debits: number; credits: number }> {
  const [row] = await db.execute<{ debits: string; credits: string }[]>(
    `SELECT COUNT(*) FILTER (WHERE e.direction = 'DEBIT')::text AS debits,
            COUNT(*) FILTER (WHERE e.direction = 'CREDIT' AND t.kind <> 'OPENING')::text AS credits
       FROM wallet_ledger_entries e
       JOIN wager_transactions t ON t.id = e.transaction_id
      WHERE e.wallet_id = ?`,
    [walletId],
  );
  return { debits: Number(row!.debits), credits: Number(row!.credits) };
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export interface ApiProcess {
  client: ApiClient;
  stop(): Promise<void>;
}

const READINESS_TIMEOUT_MS = 20_000;

/**
 * Sobe `bun src/main.ts` num processo separado, apontando para o banco de
 * testes. Pronto quando GET /wallets/<uuid aleatório> responde 404 (HTTP no ar
 * e banco acessível).
 */
export async function spawnApiProcess(): Promise<ApiProcess> {
  const port = await freePort();
  const child = Bun.spawn([process.execPath, 'src/main.ts'], {
    cwd: `${import.meta.dirname}/../..`,
    // Só a API: o publisher da outbox não deve publicar os eventos do banco de testes.
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: process.env.DATABASE_TEST_URL,
      APP_ROLES: 'api',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Drena a saída para o pipe não encher, e guarda para o diagnóstico.
  let output = '';
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
    }
  };
  void drain(child.stdout);
  void drain(child.stderr);

  const client = new ApiClient(`http://127.0.0.1:${port}`);
  const stop = async () => {
    child.kill();
    await child.exited;
  };

  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Processo da API saiu com código ${child.exitCode}:\n${output}`);
    }
    try {
      const reply = await client.call('GET', `/wallets/${crypto.randomUUID()}`);
      if (reply.status === 404) {
        return { client, stop };
      }
    } catch {
      // Ainda não está ouvindo.
    }
    await Bun.sleep(100);
  }
  await stop();
  throw new Error(`Processo da API não ficou pronto em ${READINESS_TIMEOUT_MS} ms:\n${output}`);
}
