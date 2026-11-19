import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../../src/application/errors/application-errors.js';
import { NoopWageringMetrics } from '../../../src/application/metrics/wagering-metrics.js';
import {
  UniqueConstraint,
  UniqueViolationError,
} from '../../../src/application/ports/persistence-errors.js';
import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../../src/application/ports/unit-of-work.js';
import { SubmitWagerTransactionUseCase } from '../../../src/application/wagering/submit-wager-transaction.use-case.js';
import type { SubmitWagerTransactionCommand } from '../../../src/application/wagering/submit-wager-transaction.types.js';
import { OpenWalletUseCase } from '../../../src/application/wallets/open-wallet.use-case.js';
import { FailureCode } from '../../../src/domain/wagering/failure-code.js';
import { WagerTransactionKind as Kind } from '../../../src/domain/wagering/wager-transaction-kind.js';
import { WagerTransactionStatus as Status } from '../../../src/domain/wagering/wager-transaction-status.js';
import { MikroOrmUnitOfWork } from '../../../src/infra/database/mikro-orm-unit-of-work.js';
import { UuidV7Generator } from '../../../src/infra/system/uuid-v7-generator.js';
import { openTestDatabase, type TestDatabase } from '../helpers/database.js';
import {
  assertLedgerConsistent,
  eventTypesForTransaction,
  fixedClock,
  ledgerEntriesForTransaction,
  transactionStatus,
} from './helpers.js';

let db: TestDatabase;
let uow: UnitOfWork;
let openWallet: OpenWalletUseCase;
let submit: SubmitWagerTransactionUseCase;

beforeAll(async () => {
  db = await openTestDatabase();
  uow = new MikroOrmUnitOfWork(db.orm);
  const ids = new UuidV7Generator();
  openWallet = new OpenWalletUseCase(uow, fixedClock, ids);
  submit = new SubmitWagerTransactionUseCase(uow, fixedClock, ids, new NoopWageringMetrics());
});

/**
 * Decorator da UnitOfWork real que simula "outra execução commitou primeiro":
 * as primeiras `failures` execuções lançam a violação de unicidade, as demais
 * rodam de verdade. Repositórios e banco continuam reais.
 */
class ConcurrentCommitUnitOfWork implements UnitOfWork {
  calls = 0;

  constructor(
    private readonly inner: UnitOfWork,
    private readonly failures: number,
    private readonly constraint: string,
  ) {}

  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    this.calls += 1;
    if (this.calls <= this.failures) {
      return Promise.reject(new UniqueViolationError(this.constraint));
    }
    return this.inner.run(work);
  }
}

const submitWith = (unitOfWork: UnitOfWork) =>
  new SubmitWagerTransactionUseCase(
    unitOfWork,
    fixedClock,
    new UuidV7Generator(),
    new NoopWageringMetrics(),
  );

afterAll(async () => {
  await db.close();
});

const unique = (prefix: string): string => `${prefix}-${Bun.randomUUIDv7()}`;
const brl = (amount: string) => ({ amount, currency: 'BRL' });

interface TestWallet {
  id: string;
  playerId: string;
}

async function newWallet(initialBalance = '1000.00', currency = 'BRL'): Promise<TestWallet> {
  const { id, playerId } = await openWallet.execute({
    playerId: unique('player'),
    initialBalance: { amount: initialBalance, currency },
    correlationId: unique('corr'),
  });
  return { id, playerId };
}

function command(
  wallet: TestWallet,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  return {
    providerId: 'provider-1',
    externalTransactionId: unique('ext'),
    idempotencyKey: unique('idem'),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Kind.Bet,
    money: brl('10.00'),
    correlationId: unique('corr'),
    ...overrides,
  };
}

const referencing = (
  wallet: TestWallet,
  kind: Kind,
  referenceExternalTransactionId: string,
  amount: string,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
) => command(wallet, { kind, referenceExternalTransactionId, money: brl(amount), ...overrides });

describe('SubmitWagerTransactionUseCase', () => {
  it('BET processado debita, sobe a version e publica Processed e BalanceChanged', async () => {
    const wallet = await newWallet('1000.00');

    const result = await submit.execute(command(wallet, { money: brl('25.00') }));

    expect(result).toEqual({
      transactionId: result.transactionId,
      status: Status.Processed,
      balance: brl('975.00'),
      idempotentReplay: false,
    });
    const [row] = await db.execute<{ version: number }[]>(
      'SELECT version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(row?.version).toBe(2);
    expect(await ledgerEntriesForTransaction(db, result.transactionId)).toEqual([
      { direction: 'DEBIT', amount: '25.00' },
    ]);
    expect(await eventTypesForTransaction(db, result.transactionId)).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await assertLedgerConsistent(db, wallet.id);
  });

  it('BET sem saldo é REJECTED com INSUFFICIENT_FUNDS e não altera a wallet', async () => {
    const wallet = await newWallet('10.00');

    const result = await submit.execute(command(wallet, { money: brl('10.01') }));

    expect(result).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.InsufficientFunds,
      balance: brl('10.00'),
      idempotentReplay: false,
    });
    expect(await transactionStatus(db, result.transactionId)).toBe(Status.Rejected);
    expect(await ledgerEntriesForTransaction(db, result.transactionId)).toEqual([]);
    expect(await eventTypesForTransaction(db, result.transactionId)).toEqual([
      'WagerTransactionRejected',
    ]);
    await assertLedgerConsistent(db, wallet.id);
  });

  it('replay devolve o resultado original com o saldo da época, não o atual', async () => {
    const wallet = await newWallet('1000.00');
    const firstBet = command(wallet, { money: brl('100.00') });

    const original = await submit.execute(firstBet);
    await submit.execute(command(wallet, { money: brl('200.00') }));
    const replay = await submit.execute({ ...firstBet, correlationId: unique('corr') });

    expect(replay).toEqual({
      transactionId: original.transactionId,
      status: Status.Processed,
      balance: brl('900.00'),
      idempotentReplay: true,
    });
    expect(await ledgerEntriesForTransaction(db, original.transactionId)).toHaveLength(1);
    await assertLedgerConsistent(db, wallet.id);
  });

  it('a mesma idempotency key com payload diferente lança IDEMPOTENCY_KEY_REUSED', async () => {
    const wallet = await newWallet();
    const original = command(wallet);
    await submit.execute(original);

    const attempt = submit.execute({ ...original, money: brl('11.00') });

    await expect(attempt).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(attempt).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    await assertLedgerConsistent(db, wallet.id);
  });

  it('o mesmo externalTransactionId com outra chave lança EXTERNAL_TRANSACTION_ID_CONFLICT', async () => {
    const wallet = await newWallet();
    const original = command(wallet);
    await submit.execute(original);

    const attempt = submit.execute({ ...original, idempotencyKey: unique('idem') });

    await expect(attempt).rejects.toMatchObject({ code: 'EXTERNAL_TRANSACTION_ID_CONFLICT' });
    await assertLedgerConsistent(db, wallet.id);
  });

  it('LOSS é PROCESSED sem lançamento, sem mudar a version, só com o evento Processed', async () => {
    const wallet = await newWallet('100.00');

    const result = await submit.execute(command(wallet, { kind: Kind.Loss, money: brl('0.00') }));

    expect(result).toMatchObject({ status: Status.Processed, balance: brl('100.00') });
    expect(await ledgerEntriesForTransaction(db, result.transactionId)).toEqual([]);
    expect(await eventTypesForTransaction(db, result.transactionId)).toEqual([
      'WagerTransactionProcessed',
    ]);
    const [row] = await db.execute<{ version: number }[]>(
      'SELECT version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(row?.version).toBe(1);
    await assertLedgerConsistent(db, wallet.id);
  });

  it('WIN que referencia um BET credita', async () => {
    const wallet = await newWallet('100.00');
    const bet = command(wallet, { money: brl('10.00') });
    await submit.execute(bet);

    const result = await submit.execute(
      referencing(wallet, Kind.Win, bet.externalTransactionId, '35.00'),
    );

    expect(result).toMatchObject({ status: Status.Processed, balance: brl('125.00') });
    expect(await ledgerEntriesForTransaction(db, result.transactionId)).toEqual([
      { direction: 'CREDIT', amount: '35.00' },
    ]);
    await assertLedgerConsistent(db, wallet.id);
  });

  it('REFUND de um BET credita uma vez; segundo REFUND e ROLLBACK do mesmo BET são rejeitados', async () => {
    const wallet = await newWallet('100.00');
    const bet = command(wallet, { money: brl('10.00') });
    await submit.execute(bet);

    const refund = await submit.execute(
      referencing(wallet, Kind.Refund, bet.externalTransactionId, '10.00'),
    );
    const secondRefund = await submit.execute(
      referencing(wallet, Kind.Refund, bet.externalTransactionId, '10.00'),
    );
    const rollback = await submit.execute(
      referencing(wallet, Kind.Rollback, bet.externalTransactionId, '10.00'),
    );

    expect(refund).toMatchObject({ status: Status.Processed, balance: brl('100.00') });
    expect(secondRefund).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
      balance: brl('100.00'),
    });
    expect(rollback).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
      balance: brl('100.00'),
    });
    await assertLedgerConsistent(db, wallet.id);
  });

  it('ROLLBACK de um WIN sem saldo é REVERSAL_INSUFFICIENT_FUNDS, distinto de aposta sem saldo', async () => {
    const wallet = await newWallet('10.00');
    const bet = command(wallet, { money: brl('10.00') });
    await submit.execute(bet);
    const win = referencing(wallet, Kind.Win, bet.externalTransactionId, '50.00');
    await submit.execute(win);
    await submit.execute(command(wallet, { money: brl('50.00') }));

    const rollback = await submit.execute(
      referencing(wallet, Kind.Rollback, win.externalTransactionId, '50.00'),
    );
    const betWithoutBalance = await submit.execute(command(wallet, { money: brl('1.00') }));

    expect(rollback).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReversalInsufficientFunds,
      balance: brl('0.00'),
    });
    expect(betWithoutBalance.failureCode).toBe(FailureCode.InsufficientFunds);
    await assertLedgerConsistent(db, wallet.id);
  });

  it('ROLLBACK de um BET credita de volta', async () => {
    const wallet = await newWallet('100.00');
    const bet = command(wallet, { money: brl('40.00') });
    await submit.execute(bet);

    const rollback = await submit.execute(
      referencing(wallet, Kind.Rollback, bet.externalTransactionId, '40.00'),
    );

    expect(rollback).toMatchObject({ status: Status.Processed, balance: brl('100.00') });
    await assertLedgerConsistent(db, wallet.id);
  });

  it('REFUND antes do BET fica PENDING_REFERENCE; o BET chega depois e é processado', async () => {
    const wallet = await newWallet('100.00');
    const betExternalId = unique('ext-bet');

    const refund = await submit.execute(referencing(wallet, Kind.Refund, betExternalId, '10.00'));
    const bet = await submit.execute(
      command(wallet, { externalTransactionId: betExternalId, money: brl('10.00') }),
    );

    expect(refund).toEqual({
      transactionId: refund.transactionId,
      status: Status.PendingReference,
      idempotentReplay: false,
    });
    expect(await eventTypesForTransaction(db, refund.transactionId)).toEqual([
      'WagerTransactionPendingReference',
    ]);
    expect(bet).toMatchObject({ status: Status.Processed, balance: brl('90.00') });
    expect(await transactionStatus(db, refund.transactionId)).toBe(Status.PendingReference);
    await assertLedgerConsistent(db, wallet.id);
  });

  it('replay de uma transação pendente devolve o status atual, sem saldo', async () => {
    const wallet = await newWallet('100.00');
    const pending = referencing(wallet, Kind.Refund, unique('ext-missing'), '10.00');
    await submit.execute(pending);

    const replay = await submit.execute(pending);

    expect(replay).toMatchObject({ status: Status.PendingReference, idempotentReplay: true });
    expect(replay.balance).toBeUndefined();
    await assertLedgerConsistent(db, wallet.id);
  });

  it('referência de outra rodada é REJECTED com REFERENCE_MISMATCH', async () => {
    const wallet = await newWallet('100.00');
    const bet = command(wallet, { roundId: 'round-1' });
    await submit.execute(bet);

    const win = await submit.execute(
      referencing(wallet, Kind.Win, bet.externalTransactionId, '20.00', { roundId: 'round-2' }),
    );

    expect(win).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.ReferenceMismatch,
      balance: brl('90.00'),
    });
    await assertLedgerConsistent(db, wallet.id);
  });

  it('wallet inexistente lança WalletNotFoundError', async () => {
    const wallet = await newWallet();

    await expect(
      submit.execute(command(wallet, { walletId: Bun.randomUUIDv7() })),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
    await assertLedgerConsistent(db, wallet.id);
  });

  it('player diferente do dono da wallet é REJECTED com WALLET_PLAYER_MISMATCH', async () => {
    const wallet = await newWallet('100.00');

    const result = await submit.execute(command(wallet, { playerId: unique('intruder') }));

    expect(result).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.WalletPlayerMismatch,
      balance: brl('100.00'),
    });
    await assertLedgerConsistent(db, wallet.id);
  });

  it('moeda diferente da wallet é REJECTED com CURRENCY_MISMATCH e saldo na moeda da wallet', async () => {
    const wallet = await newWallet('100.00');

    const usdBet = command(wallet, { money: { amount: '10.00', currency: 'USD' } });

    const result = await submit.execute(usdBet);
    const replay = await submit.execute(usdBet);

    expect(result).toMatchObject({
      status: Status.Rejected,
      failureCode: FailureCode.CurrencyMismatch,
      balance: brl('100.00'),
    });
    expect(replay).toMatchObject({ idempotentReplay: true, balance: brl('100.00') });
    expect(await transactionStatus(db, result.transactionId)).toBe(Status.Rejected);
    await assertLedgerConsistent(db, wallet.id);
  });

  describe('nova tentativa após commit concorrente (F5)', () => {
    it.each([
      UniqueConstraint.TransactionIdempotencyKey,
      UniqueConstraint.TransactionExternalId,
      UniqueConstraint.SingleReversal,
    ])('violação de %s: tenta mais uma vez e processa', async (constraint) => {
      const wallet = await newWallet('100.00');
      const flaky = new ConcurrentCommitUnitOfWork(uow, 1, constraint);

      const result = await submitWith(flaky).execute(command(wallet));

      expect(flaky.calls).toBe(2);
      expect(result).toMatchObject({ status: Status.Processed, balance: brl('90.00') });
      await assertLedgerConsistent(db, wallet.id);
    });

    it('segunda violação seguida sobe como anomalia, não como conflito', async () => {
      const wallet = await newWallet('100.00');
      const flaky = new ConcurrentCommitUnitOfWork(
        uow,
        2,
        UniqueConstraint.TransactionIdempotencyKey,
      );

      const attempt = submitWith(flaky).execute(command(wallet));

      await expect(attempt).rejects.toThrow(
        'Violação de unicidade persistente após nova tentativa',
      );
      await expect(attempt).rejects.not.toBeInstanceOf(UniqueViolationError);
      expect(flaky.calls).toBe(2);
      await assertLedgerConsistent(db, wallet.id);
    });

    it('violação de outra constraint não gera nova tentativa', async () => {
      const wallet = await newWallet('100.00');
      const flaky = new ConcurrentCommitUnitOfWork(uow, 1, UniqueConstraint.WalletPlayerCurrency);

      await expect(submitWith(flaky).execute(command(wallet))).rejects.toBeInstanceOf(
        UniqueViolationError,
      );
      expect(flaky.calls).toBe(1);
      await assertLedgerConsistent(db, wallet.id);
    });
  });

  describe('concorrência', () => {
    it('20 envios idênticos simultâneos: um débito e 19 replays', async () => {
      const wallet = await newWallet('100.00');
      const bet = command(wallet, { money: brl('10.00') });

      const results = await Promise.all(
        Array.from({ length: 20 }, () => submit.execute({ ...bet })),
      );

      const original = results.filter((result) => !result.idempotentReplay);
      expect(original).toHaveLength(1);
      expect(results.filter((result) => result.idempotentReplay)).toHaveLength(19);
      expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
      expect(results.every((result) => result.balance?.amount === '90.00')).toBe(true);
      expect(await ledgerEntriesForTransaction(db, original[0]!.transactionId)).toHaveLength(1);
      await assertLedgerConsistent(db, wallet.id);
    });

    it('a mesma chave para wallets diferentes ao mesmo tempo: uma processa, a outra é conflito', async () => {
      const walletA = await newWallet('100.00');
      const walletB = await newWallet('100.00');
      const key = unique('idem');
      const externalId = unique('ext');

      const results = await Promise.allSettled([
        submit.execute(
          command(walletA, { idempotencyKey: key, externalTransactionId: externalId }),
        ),
        submit.execute(
          command(walletB, { idempotencyKey: key, externalTransactionId: externalId }),
        ),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      await assertLedgerConsistent(db, walletA.id);
      await assertLedgerConsistent(db, walletB.id);
    });
  });
});
