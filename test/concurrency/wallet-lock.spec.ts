import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { NoopWageringMetrics } from '../../src/application/metrics/wagering-metrics.js';
import { TransientInfrastructureError } from '../../src/application/ports/persistence-errors.js';
import { SubmitWagerTransactionUseCase } from '../../src/application/wagering/submit-wager-transaction.use-case.js';
import type { SubmitWagerTransactionCommand } from '../../src/application/wagering/submit-wager-transaction.types.js';
import { OpenWalletUseCase } from '../../src/application/wallets/open-wallet.use-case.js';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status.js';
import { MikroOrmUnitOfWork } from '../../src/infra/database/mikro-orm-unit-of-work.js';
import { UuidV7Generator } from '../../src/infra/system/uuid-v7-generator.js';
import { openTestDatabase, type TestDatabase } from '../integration/helpers/database.js';
import { assertLedgerConsistent, fixedClock } from '../integration/use-cases/helpers.js';
import { brl, CONCURRENCY_TEST_TIMEOUT_MS, type TestWallet, unique } from './helpers.js';

const SHORT_LOCK_TIMEOUT_MS = 200;

let db: TestDatabase;
let openWallet: OpenWalletUseCase;

const submitWith = (lockTimeoutMs: number) =>
  new SubmitWagerTransactionUseCase(
    new MikroOrmUnitOfWork(db.orm, { lockTimeoutMs }),
    fixedClock,
    new UuidV7Generator(),
    new NoopWageringMetrics(),
  );

beforeAll(async () => {
  db = await openTestDatabase();
  openWallet = new OpenWalletUseCase(
    new MikroOrmUnitOfWork(db.orm),
    fixedClock,
    new UuidV7Generator(),
  );
});

afterAll(async () => {
  await db.close();
});

async function newWallet(): Promise<TestWallet> {
  const { id, playerId } = await openWallet.execute({
    playerId: unique('player'),
    initialBalance: brl('100.00'),
    correlationId: unique('corr'),
  });
  return { id, playerId };
}

function bet(wallet: TestWallet): SubmitWagerTransactionCommand {
  return {
    providerId: 'provider-lock',
    externalTransactionId: unique('ext'),
    idempotencyKey: unique('idem'),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: brl('10.00'),
    correlationId: unique('corr'),
  };
}

/**
 * Abre uma transação noutra conexão e segura o lock da linha da wallet até
 * `release()`. Sem medir tempo: o teste espera o lock estar de fato segurado.
 */
async function holdWalletLock(walletId: string) {
  let locked!: () => void;
  let release!: () => void;
  const isLocked = new Promise<void>((resolve) => (locked = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));

  const transaction = db.orm.em.fork().transactional(async (em) => {
    await em.execute('SELECT id FROM wallets WHERE id = ? FOR UPDATE', [walletId]);
    locked();
    await released;
  });

  await isLocked;
  return {
    release: async () => {
      release();
      await transaction;
    },
  };
}

describe('Lock por wallet', () => {
  it(
    'com a wallet A travada, B termina normalmente e A estoura o lock_timeout',
    async () => {
      const walletA = await newWallet();
      const walletB = await newWallet();
      const submit = submitWith(SHORT_LOCK_TIMEOUT_MS);

      const lock = await holdWalletLock(walletA.id);
      try {
        const onB = await submit.execute(bet(walletB));
        expect(onB).toMatchObject({
          status: WagerTransactionStatus.Processed,
          balance: brl('90.00'),
        });

        const onA = submit.execute(bet(walletA));
        await expect(onA).rejects.toBeInstanceOf(TransientInfrastructureError);
        await expect(onA).rejects.toMatchObject({ lockTimeout: true });
      } finally {
        await lock.release();
      }

      // Lock liberado: a mesma operação na wallet A passa.
      const afterRelease = await submit.execute(bet(walletA));
      expect(afterRelease.status).toBe(WagerTransactionStatus.Processed);

      await assertLedgerConsistent(db, walletA.id);
      await assertLedgerConsistent(db, walletB.id);
    },
    CONCURRENCY_TEST_TIMEOUT_MS,
  );
});
