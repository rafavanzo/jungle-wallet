import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
  StaleUpdateError,
  TransientInfrastructureError,
  UniqueViolationError,
} from '../../src/application/ports/persistence-errors.js';
import type { UnitOfWork } from '../../src/application/ports/unit-of-work.js';
import { Money } from '../../src/domain/shared/money.js';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction.js';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind.js';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status.js';
import { Wallet } from '../../src/domain/wallet/wallet.js';
import { MikroOrmUnitOfWork } from '../../src/infra/database/mikro-orm-unit-of-work.js';
import { openTestDatabase, type TestDatabase } from './helpers/database.js';

const OPENED_AT = new Date('2026-11-19T10:00:00.000Z');
const PROCESSED_AT = new Date('2026-11-19T10:00:05.000Z');

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const newId = (): string => Bun.randomUUIDv7();

let db: TestDatabase;
let uow: UnitOfWork;

beforeAll(async () => {
  db = await openTestDatabase();
  uow = new MikroOrmUnitOfWork(db.orm);
});

afterAll(async () => {
  await db.close();
});

function openWallet(initialBalance = '100.00') {
  return Wallet.open({
    id: newId(),
    playerId: `player-${newId()}`,
    initialBalance: brl(initialBalance),
    openingTransactionId: newId(),
    openingEntryId: newId(),
    at: OPENED_AT,
  });
}

function createTransaction(
  wallet: Wallet,
  kind: WagerTransactionKind,
  referenceExternalTransactionId?: string,
): WagerTransaction {
  return WagerTransaction.create({
    id: newId(),
    providerId: 'provider-1',
    externalTransactionId: `ext-${newId()}`,
    idempotencyKey: `idem-${newId()}`,
    payloadHash: 'hash',
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('10.00'),
    referenceExternalTransactionId,
    createdAt: OPENED_AT,
  });
}

async function insertWallet(initialBalance = '100.00'): Promise<Wallet> {
  const { wallet } = openWallet(initialBalance);
  await uow.run(({ wallets }) => wallets.insert(wallet));
  return wallet;
}

describe('repositórios (MikroORM + Postgres real)', () => {
  it('ida e volta da wallet preserva saldo, version e datas', async () => {
    const wallet = await insertWallet('1234.56');

    const loaded = await uow.run(({ wallets }) => wallets.findById(wallet.id));

    expect(loaded).toBeInstanceOf(Wallet);
    expect(loaded?.id).toBe(wallet.id);
    expect(loaded?.playerId).toBe(wallet.playerId);
    expect(loaded?.currency).toBe('BRL');
    expect(loaded?.balance).toBeInstanceOf(Money);
    expect(loaded?.balance.equals(brl('1234.56'))).toBe(true);
    expect(loaded?.version).toBe(1);
    expect(loaded?.createdAt).toEqual(OPENED_AT);
    expect(loaded?.updatedAt).toEqual(OPENED_AT);
  });

  it('ida e volta da transação com referência e resultingBalance', async () => {
    const wallet = await insertWallet();
    const bet = createTransaction(wallet, WagerTransactionKind.Bet);
    bet.markProcessed(undefined, brl('90.00'), PROCESSED_AT);
    const refund = createTransaction(
      wallet,
      WagerTransactionKind.Refund,
      bet.externalTransactionId,
    );
    refund.markProcessed(bet.id, brl('100.00'), PROCESSED_AT);

    await uow.run(async ({ transactions }) => {
      await transactions.insert(bet);
      await transactions.insert(refund);
    });
    const loaded = await uow.run(({ transactions }) => transactions.findById(refund.id));

    expect(loaded).toBeInstanceOf(WagerTransaction);
    expect(loaded?.kind).toBe(WagerTransactionKind.Refund);
    expect(loaded?.status).toBe(WagerTransactionStatus.Processed);
    expect(loaded?.money.equals(brl('10.00'))).toBe(true);
    expect(loaded?.referenceExternalTransactionId).toBe(bet.externalTransactionId);
    expect(loaded?.referenceTransactionId).toBe(bet.id);
    expect(loaded?.resultingBalance?.equals(brl('100.00'))).toBe(true);
    expect(loaded?.failureCode).toBeUndefined();
    expect(loaded?.createdAt).toEqual(OPENED_AT);
    expect(loaded?.processedAt).toEqual(PROCESSED_AT);
    expect(loaded?.idempotencyKey).toBe(refund.idempotencyKey);
    expect(loaded?.payloadHash).toBe('hash');
  });

  it('busca por idempotency key, por id externo e por reversão processada', async () => {
    const wallet = await insertWallet();
    const bet = createTransaction(wallet, WagerTransactionKind.Bet);
    bet.markProcessed(undefined, brl('90.00'), PROCESSED_AT);
    const refund = createTransaction(
      wallet,
      WagerTransactionKind.Refund,
      bet.externalTransactionId,
    );
    refund.markProcessed(bet.id, brl('100.00'), PROCESSED_AT);
    await uow.run(async ({ transactions }) => {
      await transactions.insert(bet);
    });

    const before = await uow.run(async ({ transactions }) => ({
      byKey: await transactions.findByIdempotencyKey('provider-1', bet.idempotencyKey),
      byExternal: await transactions.findByExternalId('provider-1', bet.externalTransactionId),
      otherProvider: await transactions.findByIdempotencyKey('provider-2', bet.idempotencyKey),
      reversed: await transactions.hasProcessedReversalOf(bet.id),
    }));
    await uow.run(({ transactions }) => transactions.insert(refund));
    const reversedAfter = await uow.run(({ transactions }) =>
      transactions.hasProcessedReversalOf(bet.id),
    );

    expect(before.byKey?.id).toBe(bet.id);
    expect(before.byExternal?.id).toBe(bet.id);
    expect(before.otherProvider).toBeUndefined();
    expect(before.reversed).toBe(false);
    expect(reversedAfter).toBe(true);
  });

  it('lançamentos são listados em ordem, com cursor', async () => {
    const wallet = await insertWallet();
    const transactions = [1, 2, 3].map(() => {
      const tx = createTransaction(wallet, WagerTransactionKind.Bet);
      return tx;
    });
    const entries = transactions.map((tx) =>
      wallet.debit({
        money: brl('10.00'),
        transactionId: tx.id,
        entryId: newId(),
        at: PROCESSED_AT,
      }),
    );
    transactions.forEach((tx, index) =>
      tx.markProcessed(undefined, entries[index]!.balanceAfter, PROCESSED_AT),
    );

    await uow.run(async (repositories) => {
      for (const [index, tx] of transactions.entries()) {
        await repositories.transactions.insert(tx);
        await repositories.ledger.insert(entries[index]!);
      }
    });
    const firstPage = await uow.run(({ ledger }) => ledger.listByWallet(wallet.id, undefined, 2));
    const secondPage = await uow.run(({ ledger }) =>
      ledger.listByWallet(wallet.id, firstPage.at(-1)?.id, 2),
    );

    expect(firstPage.map((entry) => entry.balanceAfter.toString())).toEqual(['90.00', '80.00']);
    expect(secondPage.map((entry) => entry.balanceAfter.toString())).toEqual(['70.00']);
    expect(secondPage[0]?.isBalanced()).toBe(true);
  });

  it('update da wallet com a version errada é rejeitado e não altera nada', async () => {
    const wallet = await insertWallet();
    wallet.debit({
      money: brl('30.00'),
      transactionId: newId(),
      entryId: newId(),
      at: PROCESSED_AT,
    });

    await expect(uow.run(({ wallets }) => wallets.update(wallet, 7))).rejects.toBeInstanceOf(
      StaleUpdateError,
    );

    const loaded = await uow.run(({ wallets }) => wallets.findById(wallet.id));
    expect(loaded?.balance.toString()).toBe('100.00');
    expect(loaded?.version).toBe(1);
  });

  it('update da wallet com a version certa grava saldo e version', async () => {
    const wallet = await insertWallet();
    const previousVersion = wallet.version;
    wallet.debit({
      money: brl('30.00'),
      transactionId: newId(),
      entryId: newId(),
      at: PROCESSED_AT,
    });

    await uow.run(({ wallets }) => wallets.update(wallet, previousVersion));

    const loaded = await uow.run(({ wallets }) => wallets.findById(wallet.id));
    expect(loaded?.balance.toString()).toBe('70.00');
    expect(loaded?.version).toBe(2);
    expect(loaded?.updatedAt).toEqual(PROCESSED_AT);
  });

  it('update da transação com o status anterior errado é rejeitado', async () => {
    const wallet = await insertWallet();
    const bet = createTransaction(wallet, WagerTransactionKind.Bet);
    await uow.run(({ transactions }) => transactions.insert(bet));
    bet.markProcessed(undefined, brl('90.00'), PROCESSED_AT);

    await expect(
      uow.run(({ transactions }) =>
        transactions.update(bet, WagerTransactionStatus.PendingReference),
      ),
    ).rejects.toBeInstanceOf(StaleUpdateError);

    await uow.run(({ transactions }) => transactions.update(bet, WagerTransactionStatus.Pending));
    const loaded = await uow.run(({ transactions }) => transactions.findById(bet.id));
    expect(loaded?.status).toBe(WagerTransactionStatus.Processed);
  });

  it('lock_timeout vira TransientInfrastructureError quando outra transação segura o lock', async () => {
    const wallet = await insertWallet();
    const impatientUow = new MikroOrmUnitOfWork(db.orm, { lockTimeoutMs: 100 });

    let signalLocked!: () => void;
    let releaseLock!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    const released = new Promise<void>((resolve) => (releaseLock = resolve));

    const holder = uow.run(async ({ wallets }) => {
      await wallets.lockById(wallet.id);
      signalLocked();
      await released;
    });
    await locked;

    const contender = impatientUow.run(({ wallets }) => wallets.lockById(wallet.id));

    await expect(contender).rejects.toBeInstanceOf(TransientInfrastructureError);
    await expect(contender).rejects.toMatchObject({ cause: { code: '55P03' } });
    releaseLock();
    await holder;
  });

  it('o lock é liberado no commit e a próxima transação o obtém', async () => {
    const wallet = await insertWallet();
    const impatientUow = new MikroOrmUnitOfWork(db.orm, { lockTimeoutMs: 100 });

    await uow.run(({ wallets }) => wallets.lockById(wallet.id));
    const relocked = await impatientUow.run(({ wallets }) => wallets.lockById(wallet.id));

    expect(relocked?.id).toBe(wallet.id);
  });

  it('violação de unicidade traduzida traz o nome da constraint', async () => {
    const wallet = await insertWallet();
    const { wallet: sameOwner } = Wallet.open({
      id: newId(),
      playerId: wallet.playerId,
      initialBalance: brl('0.00'),
      openingTransactionId: newId(),
      openingEntryId: newId(),
      at: OPENED_AT,
    });

    const attempt = uow.run(({ wallets }) => wallets.insert(sameOwner));

    await expect(attempt).rejects.toBeInstanceOf(UniqueViolationError);
    await expect(attempt).rejects.toMatchObject({ constraint: 'ux_wallets_player_currency' });
  });

  it('erro na unidade de trabalho desfaz tudo o que ela gravou', async () => {
    const { wallet } = openWallet();

    await expect(
      uow.run(async ({ wallets }) => {
        await wallets.insert(wallet);
        throw new Error('falha depois do insert');
      }),
    ).rejects.toThrow('falha depois do insert');

    const loaded = await uow.run(({ wallets }) => wallets.findById(wallet.id));
    expect(loaded).toBeUndefined();
  });
});
