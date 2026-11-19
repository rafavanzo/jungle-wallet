import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { AddressInfo } from 'node:net';

import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';

import { PublishOutboxBatchUseCase } from '../../src/application/outbox/publish-outbox-batch.use-case.js';
import type { EventPublisher, OutgoingEvent } from '../../src/application/ports/event-publisher.js';
import { OpenWalletUseCase } from '../../src/application/wallets/open-wallet.use-case.js';
import { createHttpApp } from '../../src/http/create-http-app.js';
import { buildOrmConfig } from '../../src/infra/database/mikro-orm.config.js';
import { MikroOrmUnitOfWork } from '../../src/infra/database/mikro-orm-unit-of-work.js';
import {
  createSqsClient,
  readSqsSettings,
  SqsEventPublisher,
} from '../../src/infra/messaging/sqs-event-publisher.js';
import { SystemClock } from '../../src/infra/system/system-clock.js';
import { UuidV7Generator } from '../../src/infra/system/uuid-v7-generator.js';
import { openThrowawayTestDatabase, type TestDatabase } from './helpers/database.js';
import { type EventsQueue, openEventsQueue } from './helpers/sqs.js';

const TEST_TIMEOUT_MS = 30_000;

// Banco descartável: a outbox começa vazia, sem os eventos acumulados pelos outros testes.
let db: TestDatabase;
let queue: EventsQueue;
let sqsPublisher: SqsEventPublisher;
let openWallet: OpenWalletUseCase;
const clock = new SystemClock();

beforeAll(async () => {
  db = await openThrowawayTestDatabase();
  queue = await openEventsQueue();
  sqsPublisher = new SqsEventPublisher(queue.client, queue.name);
  openWallet = new OpenWalletUseCase(new MikroOrmUnitOfWork(db.orm), clock, new UuidV7Generator());
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  queue?.client.destroy();
  await db?.close();
});

const unique = (prefix: string): string => `${prefix}-${Bun.randomUUIDv7()}`;

const publisherWith = (publisher: EventPublisher, orm: MikroORM = db.orm) =>
  new PublishOutboxBatchUseCase(new MikroOrmUnitOfWork(orm), publisher, clock);

/** Roda ciclos até um ciclo não encontrar nada. */
async function drain(publisher: PublishOutboxBatchUseCase): Promise<void> {
  while ((await publisher.execute()).claimed > 0) {}
}

/** Datas em epoch ms: o execute bruto devolve timestamptz como texto. */
interface OutboxRow {
  id: string;
  attempts: number;
  next_attempt_ms: number;
  published_ms: number | null;
  last_error: string | null;
}

async function outboxRows(ids: readonly string[]): Promise<OutboxRow[]> {
  return db.execute<OutboxRow[]>(
    `SELECT id, attempts, last_error,
            (extract(epoch FROM next_attempt_at) * 1000)::float8 AS next_attempt_ms,
            (extract(epoch FROM published_at) * 1000)::float8 AS published_ms
       FROM outbox_messages WHERE id IN (?) ORDER BY id`,
    [ids],
  );
}

async function pendingIds(): Promise<string[]> {
  const rows = await db.execute<{ id: string }[]>(
    'SELECT id FROM outbox_messages WHERE published_at IS NULL ORDER BY id',
  );
  return rows.map((row) => row.id);
}

/** Abre wallets com saldo: cada uma grava 2 eventos na outbox (transação OPENING e saldo). */
async function openWallets(count: number): Promise<string[]> {
  const before = new Set(await pendingIds());
  for (let index = 0; index < count; index += 1) {
    await openWallet.execute({
      playerId: unique('player'),
      initialBalance: { amount: '100.00', currency: 'BRL' },
      correlationId: unique('corr'),
    });
  }
  return (await pendingIds()).filter((id) => !before.has(id));
}

/** Conta as publicações por eventId; opcionalmente para todos num ponto de encontro. */
class CountingPublisher implements EventPublisher {
  published = 0;
  private waitedAtBarrier = false;

  constructor(
    private readonly inner: EventPublisher,
    private readonly counts: Map<string, number>,
    private readonly barrier?: Barrier,
  ) {}

  async publish(event: OutgoingEvent): Promise<void> {
    if (this.barrier && !this.waitedAtBarrier) {
      this.waitedAtBarrier = true;
      await this.barrier.arrive();
    }
    await this.inner.publish(event);
    this.counts.set(event.eventId, (this.counts.get(event.eventId) ?? 0) + 1);
    this.published += 1;
  }
}

/** Libera todos quando `parties` chegarem. */
class Barrier {
  private arrived = 0;
  private open!: () => void;
  private readonly opened = new Promise<void>((resolve) => (this.open = resolve));

  constructor(private readonly parties: number) {}

  arrive(): Promise<void> {
    this.arrived += 1;
    if (this.arrived === this.parties) {
      this.open();
    }
    return this.opened;
  }
}

describe('Publisher da outbox (MiniStack e Postgres reais)', () => {
  it(
    'transação processada pela API tem os eventos publicados e published_at preenchido',
    async () => {
      const originalDatabaseUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = db.url;
      let app: INestApplication | undefined;
      try {
        app = await createHttpApp({ logger: false });
        await app.listen(0);
        const { port } = app.getHttpServer().address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${port}`;
        const post = (path: string, body: object, headers: Record<string, string> = {}) =>
          fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
          }).then(async (response) => ({ status: response.status, body: await response.json() }));

        const wallet = await post('/wallets', {
          playerId: unique('player'),
          initialBalance: { amount: '100.00', currency: 'BRL' },
        });
        expect(wallet.status).toBe(201);
        const bet = await post(
          '/wagering/transactions',
          {
            providerId: 'provider-outbox',
            externalTransactionId: unique('ext'),
            playerId: wallet.body.playerId,
            walletId: wallet.body.id,
            roundId: 'round-1',
            gameId: 'game-1',
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
          },
          { 'Idempotency-Key': unique('idem') },
        );
        expect(bet.status).toBe(201);

        const betEvents = await db.execute<{ id: string; payload: Record<string, unknown> }[]>(
          `SELECT id, payload FROM outbox_messages
            WHERE payload -> 'data' ->> 'walletId' = ?
            ORDER BY id`,
          [wallet.body.id],
        );
        const eventIds = betEvents.map((event) => event.id);
        // OPENING (2 eventos) e BET (2 eventos).
        expect(eventIds).toHaveLength(4);

        await drain(publisherWith(sqsPublisher));

        for (const row of await outboxRows(eventIds)) {
          expect(row.published_ms).toBeNumber();
          expect(row.attempts).toBe(0);
        }
        const received = await queue.receive(eventIds);
        expect([...received.keys()].sort()).toEqual([...eventIds].sort());
        for (const event of betEvents) {
          const delivery = received.get(event.id)!;
          expect(delivery.deliveries).toBe(1);
          expect(delivery.groupId).toBe(wallet.body.id);
          expect(delivery.body).toEqual(event.payload);
        }
      } finally {
        await app?.close();
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'dois publishers simultâneos sobre 50 pendentes: todas publicadas, nenhuma pelos dois',
    async () => {
      const eventIds = await openWallets(25);
      expect(eventIds).toHaveLength(50);
      expect(await pendingIds()).toEqual([...eventIds].sort());

      // Cada publisher só publica depois que os dois travaram um lote: os lotes
      // coexistem. Sem SKIP LOCKED o segundo esperaria o primeiro e o teste travaria.
      const counts = new Map<string, number>();
      const barrier = new Barrier(2);
      const first = new CountingPublisher(sqsPublisher, counts, barrier);
      const second = new CountingPublisher(sqsPublisher, counts, barrier);

      await Promise.all([drain(publisherWith(first)), drain(publisherWith(second))]);

      expect(counts.size).toBe(50);
      expect([...counts.values()].every((count) => count === 1)).toBe(true);
      expect(first.published).toBeGreaterThan(0);
      expect(second.published).toBeGreaterThan(0);
      expect(first.published + second.published).toBe(50);
      expect(await pendingIds()).toEqual([]);

      const received = await queue.receive(eventIds);
      expect(received.size).toBe(50);
      expect([...received.values()].every((event) => event.deliveries === 1)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'seção 11: commitada, o processo morre depois de publicar e antes do commit, outra instância publica',
    async () => {
      // (1) O Postgres confirmou o commit: os eventos estão na outbox.
      const eventIds = await openWallets(1);
      expect(eventIds).toHaveLength(2);

      // (2) O processo trava o lote, publica a primeira e morre antes do commit.
      const crashing = Bun.spawn(
        [process.execPath, `${import.meta.dirname}/fixtures/crash-after-publish.ts`],
        { env: { ...process.env, DATABASE_URL: db.url }, stdout: 'pipe', stderr: 'pipe' },
      );
      let firstPublished: string;
      try {
        firstPublished = await waitForLine(crashing.stdout, /^PUBLISHED (\S+)$/m);
      } finally {
        crashing.kill();
        await crashing.exited;
      }
      expect(firstPublished).toBe(eventIds[0]!);
      // A transação morreu junto: nada ficou registrado como publicado.
      expect(await pendingIds()).toEqual(eventIds);

      // (3) Uma instância nova (outro ORM, outras conexões) assume e (4) publica.
      const counts = new Map<string, number>();
      const freshOrm = await MikroORM.init(buildOrmConfig(db.url));
      try {
        const fresh = publisherWith(
          new CountingPublisher(
            new SqsEventPublisher(createSqsClient(readSqsSettings()), queue.name),
            counts,
          ),
          freshOrm,
        );
        // O Postgres pode levar um instante para notar a conexão perdida e soltar as travas.
        const deadline = Date.now() + 10_000;
        while ((await pendingIds()).length > 0 && Date.now() < deadline) {
          await fresh.execute();
        }
      } finally {
        await freshOrm.close(true);
      }
      for (const row of await outboxRows(eventIds)) {
        expect(row.published_ms).toBeNumber();
      }
      expect(counts.get(firstPublished)).toBe(1);

      // (5) O primeiro evento foi publicado duas vezes, com o mesmo eventId: a
      // fila FIFO descarta a segunda, e o consumidor deduplica pelo eventId.
      const received = await queue.receive(eventIds);
      expect(received.size).toBe(2);
      expect([...received.values()].map((event) => event.deliveries)).toEqual([1, 1]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'SQS indisponível: reagenda com attempts, next_attempt_at e last_error; depois publica',
    async () => {
      const eventIds = await openWallets(1);
      const [before] = await outboxRows(eventIds);

      const unreachable = new SqsEventPublisher(
        createSqsClient({ endpoint: 'http://127.0.0.1:1', region: 'us-east-1' }),
        queue.name,
      );
      const result = await publisherWith(unreachable).execute();

      expect(result).toEqual({ claimed: 2, published: 0, failed: 2 });
      for (const row of await outboxRows(eventIds)) {
        expect(row.published_ms).toBeNull();
        expect(row.attempts).toBe(1);
        expect(row.next_attempt_ms).toBeGreaterThan(before!.next_attempt_ms);
        expect(row.last_error).toContain('ECONNREFUSED');
      }
      // Ainda não venceu (backoff de 2 s): um ciclo imediato não pega nada.
      expect((await publisherWith(sqsPublisher).execute()).claimed).toBe(0);

      // Com o endpoint certo, publica assim que o backoff vence.
      const deadline = Date.now() + 10_000;
      while ((await pendingIds()).length > 0 && Date.now() < deadline) {
        await publisherWith(sqsPublisher).execute();
        await Bun.sleep(200);
      }
      for (const row of await outboxRows(eventIds)) {
        expect(row.published_ms).toBeNumber();
        expect(row.attempts).toBe(1);
      }
      expect((await queue.receive(eventIds)).size).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );
});

/** Lê o stdout até uma linha casar com o padrão; devolve o primeiro grupo. */
async function waitForLine(stream: ReadableStream<Uint8Array>, pattern: RegExp): Promise<string> {
  const decoder = new TextDecoder();
  let output = '';
  for await (const chunk of stream) {
    output += decoder.decode(chunk, { stream: true });
    const match = pattern.exec(output);
    if (match) {
      return match[1]!;
    }
  }
  throw new Error(`O processo terminou sem imprimir ${pattern}:\n${output}`);
}
