import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import {
  InvalidPlayerIdError,
  WalletAlreadyExistsError,
} from '../../../src/application/errors/application-errors.js';
import { OpenWalletUseCase } from '../../../src/application/wallets/open-wallet.use-case.js';
import { MikroOrmUnitOfWork } from '../../../src/infra/database/mikro-orm-unit-of-work.js';
import { UuidV7Generator } from '../../../src/infra/system/uuid-v7-generator.js';
import { openTestDatabase, type TestDatabase } from '../helpers/database.js';
import { assertLedgerConsistent, fixedClock } from './helpers.js';

let db: TestDatabase;
let openWallet: OpenWalletUseCase;

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

const newPlayer = (): string => `player-${Bun.randomUUIDv7()}`;

async function count(sql: string, params: unknown[]): Promise<number> {
  const [row] = await db.execute<{ total: string }[]>(sql, params);
  return Number(row?.total);
}

describe('OpenWalletUseCase', () => {
  it('com 1000.00 grava wallet, transação OPENING, lançamento CREDIT e 2 eventos', async () => {
    const playerId = newPlayer();

    const result = await openWallet.execute({
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
      correlationId: 'corr-1',
    });

    expect(result).toEqual({
      id: result.id,
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    const [opening] = await db.execute<{ kind: string; status: string; amount: string }[]>(
      'SELECT kind, status, amount::text AS amount FROM wager_transactions WHERE wallet_id = ?',
      [result.id],
    );
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED', amount: '1000.00' });
    const entries = await db.execute<{ direction: string; balance_after: string }[]>(
      'SELECT direction, balance_after::text AS balance_after FROM wallet_ledger_entries WHERE wallet_id = ?',
      [result.id],
    );
    expect(entries).toEqual([{ direction: 'CREDIT', balance_after: '1000.00' }]);
    const events = await db.execute<{ event_type: string; correlation_id: string }[]>(
      `SELECT event_type, payload ->> 'correlationId' AS correlation_id FROM outbox_messages
        WHERE payload -> 'data' ->> 'walletId' = ? ORDER BY id`,
      [result.id],
    );
    expect(events).toEqual([
      { event_type: 'WagerTransactionProcessed', correlation_id: 'corr-1' },
      { event_type: 'WalletBalanceChanged', correlation_id: 'corr-1' },
    ]);

    await assertLedgerConsistent(db, result.id);
  });

  it('com 0.00 grava só a wallet, sem transação, lançamento nem evento', async () => {
    const result = await openWallet.execute({
      playerId: newPlayer(),
      initialBalance: { amount: '0.00', currency: 'BRL' },
      correlationId: 'corr-2',
    });

    expect(result.balance).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(result.version).toBe(1);
    expect(
      await count('SELECT count(*) AS total FROM wager_transactions WHERE wallet_id = ?', [
        result.id,
      ]),
    ).toBe(0);
    expect(
      await count('SELECT count(*) AS total FROM wallet_ledger_entries WHERE wallet_id = ?', [
        result.id,
      ]),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS total FROM outbox_messages WHERE payload -> 'data' ->> 'walletId' = ?",
        [result.id],
      ),
    ).toBe(0);

    await assertLedgerConsistent(db, result.id);
  });

  it('wallet duplicada para o mesmo player e moeda lança WalletAlreadyExistsError', async () => {
    const playerId = newPlayer();
    const first = await openWallet.execute({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
      correlationId: 'corr-3',
    });

    await expect(
      openWallet.execute({
        playerId,
        initialBalance: { amount: '20.00', currency: 'BRL' },
        correlationId: 'corr-4',
      }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);

    await assertLedgerConsistent(db, first.id);
  });

  it('o mesmo player pode ter wallets em moedas diferentes', async () => {
    const playerId = newPlayer();
    const brl = await openWallet.execute({
      playerId,
      initialBalance: { amount: '10.00', currency: 'BRL' },
      correlationId: 'corr-5',
    });
    const usd = await openWallet.execute({
      playerId,
      initialBalance: { amount: '10.00', currency: 'USD' },
      correlationId: 'corr-6',
    });

    expect(usd.id).not.toBe(brl.id);
    await assertLedgerConsistent(db, brl.id);
    await assertLedgerConsistent(db, usd.id);
  });

  it('playerId vazio lança InvalidPlayerIdError', async () => {
    await expect(
      openWallet.execute({
        playerId: '  ',
        initialBalance: { amount: '10.00', currency: 'BRL' },
        correlationId: 'corr-7',
      }),
    ).rejects.toBeInstanceOf(InvalidPlayerIdError);
  });
});
