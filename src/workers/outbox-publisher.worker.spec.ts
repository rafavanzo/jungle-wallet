import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { Logger } from '@nestjs/common';

import type { OutboxBatchResult } from '../application/outbox/publish-outbox-batch.use-case.js';
import { OutboxPublisherWorker } from './outbox-publisher.worker.js';

const BATCH_SIZE = 10;
const LONG_IDLE_MS = 60_000;

beforeAll(() => Logger.overrideLogger(false));
afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose', 'fatal']));

const batch = (claimed: number): OutboxBatchResult => ({ claimed, published: claimed, failed: 0 });

/** Ciclo falso: cada chamada consome o próximo passo do roteiro. */
function scriptedBatches(steps: (() => Promise<OutboxBatchResult>)[]) {
  let calls = 0;
  const waiters: { count: number; resolve: () => void }[] = [];
  return {
    get calls() {
      return calls;
    },
    /** Resolve quando execute() tiver sido chamado `count` vezes. */
    calledTimes(count: number): Promise<void> {
      return calls >= count
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push({ count, resolve }));
    },
    execute(): Promise<OutboxBatchResult> {
      calls += 1;
      for (const waiter of waiters.filter((waiter) => waiter.count <= calls)) {
        waiter.resolve();
      }
      const step = steps[Math.min(calls, steps.length) - 1]!;
      return step();
    },
  };
}

describe('OutboxPublisherWorker', () => {
  it('lote cheio roda de novo na hora; lote incompleto espera', async () => {
    const batches = scriptedBatches([
      async () => batch(BATCH_SIZE),
      async () => batch(BATCH_SIZE),
      async () => batch(3),
    ]);
    const worker = new OutboxPublisherWorker(batches, BATCH_SIZE, LONG_IDLE_MS);

    worker.start();
    await batches.calledTimes(3);
    await Bun.sleep(20);

    // O terceiro lote veio incompleto: o worker está na espera de 60 s, não num quarto ciclo.
    expect(batches.calls).toBe(3);
    await worker.stop();
    expect(batches.calls).toBe(3);
  });

  it('stop() durante um lote: espera o lote terminar e não busca outro', async () => {
    let finishBatch!: (result: OutboxBatchResult) => void;
    const inFlight = new Promise<OutboxBatchResult>((resolve) => (finishBatch = resolve));
    const batches = scriptedBatches([() => inFlight]);
    const worker = new OutboxPublisherWorker(batches, BATCH_SIZE, LONG_IDLE_MS);

    worker.start();
    await batches.calledTimes(1);
    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    await Bun.sleep(20);
    expect(stopped).toBe(false);

    // Lote cheio: sem o stop, o worker buscaria outro na hora.
    finishBatch(batch(BATCH_SIZE));
    await stopping;
    expect(batches.calls).toBe(1);
  });

  it('erro num ciclo não derruba o loop', async () => {
    const batches = scriptedBatches([
      () => Promise.reject(new Error('banco fora do ar')),
      async () => batch(0),
    ]);
    const worker = new OutboxPublisherWorker(batches, BATCH_SIZE, 1);

    worker.start();
    await batches.calledTimes(2);
    await worker.stop();
    expect(batches.calls).toBeGreaterThanOrEqual(2);
  });
});
