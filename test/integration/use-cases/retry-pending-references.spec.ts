import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { NoopWageringMetrics } from '../../../src/application/metrics/wagering-metrics.js';
import type { Clock } from '../../../src/application/ports/clock.js';
import { RetryPendingReferencesUseCase } from '../../../src/application/wagering/retry-pending-references.use-case.js';
import { SubmitWagerTransactionUseCase } from '../../../src/application/wagering/submit-wager-transaction.use-case.js';
import type { SubmitWagerTransactionCommand } from '../../../src/application/wagering/submit-wager-transaction.types.js';
import { OpenWalletUseCase } from '../../../src/application/wallets/open-wallet.use-case.js';
import { FailureCode } from '../../../src/domain/wagering/failure-code.js';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction-status.js';
import { MikroOrmUnitOfWork } from '../../../src/infra/database/mikro-orm-unit-of-work.js';
import { UuidV7Generator } from '../../../src/infra/system/uuid-v7-generator.js';
import { openThrowawayTestDatabase, type TestDatabase } from '../helpers/database.js';
import { assertLedgerConsistent, eventTypesForTransaction, transactionStatus } from './helpers.js';

/** Relógio que o teste avança. */
class ManualClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

// Banco descartável: o worker busca pendentes no banco inteiro.
let db: TestDatabase;
let clock: ManualClock;
let openWallet: OpenWalletUseCase;
let submit: SubmitWagerTransactionUseCase;
const ids = new UuidV7Generator();

const newWorker = () =>
  new RetryPendingReferencesUseCase(new MikroOrmUnitOfWork(db.orm), clock, ids);

beforeAll(async () => {
  db = await openThrowawayTestDatabase();
  clock = new ManualClock(new Date('2026-11-19T12:00:00.000Z'));
  const uow = new MikroOrmUnitOfWork(db.orm);
  openWallet = new OpenWalletUseCase(uow, clock, ids);
  submit = new SubmitWagerTransactionUseCase(uow, clock, ids, new NoopWageringMetrics());
});

afterAll(async () => {
  await db.close();
});

const unique = (prefix: string): string => `${prefix}-${Bun.randomUUIDv7()}`;
const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function newWallet() {
  return openWallet.execute({
    playerId: unique('player'),
    initialBalance: brl('100.00'),
    correlationId: unique('corr'),
  });
}

function command(
  wallet: { id: string; playerId: string },
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  return {
    providerId: 'provider-pending',
    externalTransactionId: unique('ext'),
    idempotencyKey: unique('idem'),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('25.00'),
    correlationId: unique('corr'),
    ...overrides,
  };
}

async function balance(walletId: string): Promise<string> {
  const [row] = await db.execute<{ balance: string }[]>(
    'SELECT balance::text AS balance FROM wallets WHERE id = ?',
    [walletId],
  );
  return row!.balance;
}

describe('Worker de referência pendente', () => {
  it('REFUND antes do BET: o BET chega e o ciclo seguinte processa o REFUND', async () => {
    const wallet = await newWallet();
    const betExternalId = unique('bet');
    const refund = await submit.execute(
      command(wallet, { kind: Kind.Refund, referenceExternalTransactionId: betExternalId }),
    );
    expect(refund.status).toBe(Status.PendingReference);

    const bet = await submit.execute(command(wallet, { externalTransactionId: betExternalId }));
    expect(bet.status).toBe(Status.Processed);
    expect(await balance(wallet.id)).toBe('75.00');

    // Antes do vencimento (1 s), nada acontece.
    expect((await newWorker().execute()).candidates).toBe(0);

    clock.advance(1_500);
    const cycle = await newWorker().execute();

    expect(cycle.outcomes).toEqual([Status.Processed]);
    expect(await transactionStatus(db, refund.transactionId)).toBe(Status.Processed);
    expect(await balance(wallet.id)).toBe('100.00');
    expect(await eventTypesForTransaction(db, refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await assertLedgerConsistent(db, wallet.id);
  });

  it('sem o BET: esgota as tentativas e rejeita com REFERENCE_NOT_FOUND', async () => {
    const wallet = await newWallet();
    const refund = await submit.execute(
      command(wallet, { kind: Kind.Refund, referenceExternalTransactionId: unique('missing') }),
    );
    expect(refund.status).toBe(Status.PendingReference);

    let cycles = 0;
    while ((await transactionStatus(db, refund.transactionId)) === Status.PendingReference) {
      expect(cycles).toBeLessThan(20);
      // Além do teto do backoff (5 min): toda tentativa vence.
      clock.advance(10 * 60 * 1_000);
      await newWorker().execute();
      cycles += 1;
    }

    const [row] = await db.execute<{ status: string; failure_code: string; attempts: number }[]>(
      'SELECT status, failure_code, reference_attempts AS attempts FROM wager_transactions WHERE id = ?',
      [refund.transactionId],
    );
    expect(row).toEqual({
      status: Status.Rejected,
      failure_code: FailureCode.ReferenceNotFound,
      attempts: 10,
    });
    expect(await eventTypesForTransaction(db, refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await balance(wallet.id)).toBe('100.00');
    await assertLedgerConsistent(db, wallet.id);
  });

  it('dois workers simultâneos no mesmo pendente: processado uma única vez', async () => {
    const wallet = await newWallet();
    const betExternalId = unique('bet');
    const refund = await submit.execute(
      command(wallet, { kind: Kind.Refund, referenceExternalTransactionId: betExternalId }),
    );
    await submit.execute(command(wallet, { externalTransactionId: betExternalId }));
    clock.advance(1_500);

    const [first, second] = await Promise.all([newWorker().execute(), newWorker().execute()]);

    const outcomes = [...first.outcomes, ...second.outcomes];
    expect(outcomes.filter((outcome) => outcome === Status.Processed)).toHaveLength(1);
    expect(outcomes.every((o) => o === Status.Processed || o === 'SKIPPED')).toBe(true);
    const [credits] = await db.execute<{ count: string }[]>(
      "SELECT COUNT(*)::text AS count FROM wallet_ledger_entries WHERE transaction_id = ? AND direction = 'CREDIT'",
      [refund.transactionId],
    );
    expect(credits!.count).toBe('1');
    expect(await balance(wallet.id)).toBe('100.00');
    await assertLedgerConsistent(db, wallet.id);
  });
});
