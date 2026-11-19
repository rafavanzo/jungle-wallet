import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { openTestDatabase, SqlState, type TestDatabase } from './helpers/database.js';

const AT = new Date('2026-11-19T10:00:00.000Z');

type Row = Record<string, unknown>;

let db: TestDatabase;

beforeAll(async () => {
  db = await openTestDatabase();
});

afterAll(async () => {
  await db.close();
});

const newId = (): string => Bun.randomUUIDv7();

async function insert(table: string, row: Row): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  await db.execute(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    Object.values(row),
  );
}

async function insertWallet(overrides: Row = {}): Promise<Row> {
  const row = {
    id: newId(),
    player_id: `player-${newId()}`,
    currency: 'BRL',
    balance: '100.00',
    version: 1,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
  await insert('wallets', row);
  return row;
}

async function insertTransaction(wallet: Row, overrides: Row = {}): Promise<Row> {
  const row = {
    id: newId(),
    provider_id: 'provider-1',
    external_transaction_id: `ext-${newId()}`,
    idempotency_key: `idem-${newId()}`,
    payload_hash: 'hash',
    wallet_id: wallet.id,
    player_id: wallet.player_id,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: 'BET',
    amount: '10.00',
    currency: wallet.currency,
    status: 'PENDING',
    created_at: AT,
    ...overrides,
  };
  await insert('wager_transactions', row);
  return row;
}

const processed = (overrides: Row = {}): Row => ({
  status: 'PROCESSED',
  processed_at: AT,
  resulting_balance: '90.00',
  ...overrides,
});

async function insertLedgerEntry(transaction: Row, overrides: Row = {}): Promise<Row> {
  const row = {
    id: newId(),
    wallet_id: transaction.wallet_id,
    transaction_id: transaction.id,
    direction: 'DEBIT',
    amount: '10.00',
    currency: transaction.currency,
    balance_before: '100.00',
    balance_after: '90.00',
    created_at: AT,
    ...overrides,
  };
  await insert('wallet_ledger_entries', row);
  return row;
}

async function processedBetWithEntry() {
  const wallet = await insertWallet();
  const bet = await insertTransaction(wallet, processed());
  const entry = await insertLedgerEntry(bet);
  return { wallet, bet, entry };
}

const reversalOf = (bet: Row, kind: 'REFUND' | 'ROLLBACK', overrides: Row = {}): Row => ({
  kind,
  reference_external_transaction_id: bet.external_transaction_id,
  ...overrides,
});

describe('constraints do schema (SQL direto, sem passar pelo domínio)', () => {
  describe('wallets', () => {
    it('saldo negativo falha com check violation', async () => {
      const wallet = await insertWallet();

      await expect(
        db.execute('UPDATE wallets SET balance = -1 WHERE id = ?', [wallet.id]),
      ).rejects.toMatchObject({ code: SqlState.CheckViolation });
    });

    it('segunda wallet para o mesmo player e moeda falha com unique violation', async () => {
      const wallet = await insertWallet();

      await expect(insertWallet({ player_id: wallet.player_id })).rejects.toMatchObject({
        code: SqlState.UniqueViolation,
      });
    });

    it('NUMERIC volta do driver como string, nunca como number', async () => {
      const wallet = await insertWallet({ balance: '1234.50' });

      const [row] = await db.execute<Row[]>('SELECT balance FROM wallets WHERE id = ?', [
        wallet.id,
      ]);

      expect(row?.balance).toBe('1234.50');
    });
  });

  describe('wager_transactions', () => {
    it('idempotency key duplicada no mesmo provedor falha', async () => {
      const wallet = await insertWallet();
      const first = await insertTransaction(wallet);

      await expect(
        insertTransaction(wallet, { idempotency_key: first.idempotency_key }),
      ).rejects.toMatchObject({ code: SqlState.UniqueViolation });
    });

    it('a mesma idempotency key em outro provedor é aceita', async () => {
      const wallet = await insertWallet();
      const first = await insertTransaction(wallet);

      await insertTransaction(wallet, {
        provider_id: 'provider-2',
        idempotency_key: first.idempotency_key,
      });
    });

    it('o mesmo (provider_id, external_transaction_id) falha', async () => {
      const wallet = await insertWallet();
      const first = await insertTransaction(wallet);

      await expect(
        insertTransaction(wallet, { external_transaction_id: first.external_transaction_id }),
      ).rejects.toMatchObject({ code: SqlState.UniqueViolation });
    });

    it('REFUND sem referência falha com check violation', async () => {
      const wallet = await insertWallet();

      await expect(insertTransaction(wallet, { kind: 'REFUND' })).rejects.toMatchObject({
        code: SqlState.CheckViolation,
      });
    });

    it('REJECTED sem failure_code falha com check violation', async () => {
      const wallet = await insertWallet();

      await expect(
        insertTransaction(wallet, { status: 'REJECTED', processed_at: AT }),
      ).rejects.toMatchObject({ code: SqlState.CheckViolation });
    });

    it('PROCESSED sem processed_at falha com check violation', async () => {
      const wallet = await insertWallet();

      await expect(insertTransaction(wallet, { status: 'PROCESSED' })).rejects.toMatchObject({
        code: SqlState.CheckViolation,
      });
    });

    it('BET com valor zero falha, LOSS com valor zero é aceito', async () => {
      const wallet = await insertWallet();

      await expect(insertTransaction(wallet, { amount: '0.00' })).rejects.toMatchObject({
        code: SqlState.CheckViolation,
      });
      await insertTransaction(wallet, { kind: 'LOSS', amount: '0.00' });
    });

    it('UPDATE numa transação PROCESSED falha com restrict_violation', async () => {
      const { bet } = await processedBetWithEntry();

      await expect(
        db.execute("UPDATE wager_transactions SET payload_hash = 'x' WHERE id = ?", [bet.id]),
      ).rejects.toMatchObject({ code: SqlState.RestrictViolation });
    });

    it('UPDATE numa transação ainda PENDING é aceito', async () => {
      const wallet = await insertWallet();
      const bet = await insertTransaction(wallet);

      await db.execute(
        "UPDATE wager_transactions SET status = 'PROCESSED', processed_at = ?, resulting_balance = '90.00' WHERE id = ?",
        [AT, bet.id],
      );
    });
  });

  describe('reversão única', () => {
    it('segunda reversão PROCESSED do mesmo BET falha; uma reversão rejeitada passa', async () => {
      const { wallet, bet } = await processedBetWithEntry();
      const resolved = { reference_transaction_id: bet.id };

      await insertTransaction(wallet, processed({ ...reversalOf(bet, 'REFUND'), ...resolved }));
      await insertTransaction(
        wallet,
        reversalOf(bet, 'ROLLBACK', {
          status: 'REJECTED',
          failure_code: 'REFERENCE_ALREADY_REVERSED',
          processed_at: AT,
          resulting_balance: '100.00',
        }),
      );

      await expect(
        insertTransaction(wallet, processed({ ...reversalOf(bet, 'ROLLBACK'), ...resolved })),
      ).rejects.toMatchObject({ code: SqlState.UniqueViolation });
    });

    it('reversão PROCESSED sem reference_transaction_id falha (o NULL escaparia do índice)', async () => {
      const { wallet, bet } = await processedBetWithEntry();

      await expect(
        insertTransaction(wallet, processed(reversalOf(bet, 'REFUND'))),
      ).rejects.toMatchObject({ code: SqlState.CheckViolation });
    });

    it('referência resolvida numa wallet diferente falha pela FK composta', async () => {
      const { bet } = await processedBetWithEntry();
      const otherWallet = await insertWallet();

      await expect(
        insertTransaction(
          otherWallet,
          processed({ ...reversalOf(bet, 'REFUND'), reference_transaction_id: bet.id }),
        ),
      ).rejects.toMatchObject({ code: SqlState.ForeignKeyViolation });
    });
  });

  describe('wallet_ledger_entries', () => {
    it('dois lançamentos para a mesma transação e wallet falham', async () => {
      const { bet } = await processedBetWithEntry();

      await expect(
        insertLedgerEntry(bet, { balance_before: '90.00', balance_after: '80.00' }),
      ).rejects.toMatchObject({ code: SqlState.UniqueViolation });
    });

    it('aritmética errada (100 − 30 = 80) falha com check violation', async () => {
      const wallet = await insertWallet();
      const bet = await insertTransaction(wallet, processed({ amount: '30.00' }));

      await expect(
        insertLedgerEntry(bet, {
          amount: '30.00',
          balance_before: '100.00',
          balance_after: '80.00',
        }),
      ).rejects.toMatchObject({ code: SqlState.CheckViolation });
    });

    it('lançamento com valor zero falha com check violation', async () => {
      const wallet = await insertWallet();
      const loss = await insertTransaction(wallet, processed({ kind: 'LOSS', amount: '0.00' }));

      await expect(
        insertLedgerEntry(loss, {
          amount: '0.00',
          balance_before: '100.00',
          balance_after: '100.00',
        }),
      ).rejects.toMatchObject({ code: SqlState.CheckViolation });
    });

    it('lançamento em USD numa wallet em BRL falha pela FK composta', async () => {
      const wallet = await insertWallet();
      const bet = await insertTransaction(wallet, processed());

      await expect(insertLedgerEntry(bet, { currency: 'USD' })).rejects.toMatchObject({
        code: SqlState.ForeignKeyViolation,
      });
    });

    it('lançamento numa wallet diferente da transação falha pela FK composta', async () => {
      const wallet = await insertWallet();
      const bet = await insertTransaction(wallet, processed());
      const otherWallet = await insertWallet();

      await expect(insertLedgerEntry(bet, { wallet_id: otherWallet.id })).rejects.toMatchObject({
        code: SqlState.ForeignKeyViolation,
      });
    });

    it('UPDATE no ledger falha com restrict_violation', async () => {
      const { entry } = await processedBetWithEntry();

      await expect(
        db.execute("UPDATE wallet_ledger_entries SET amount = '1.00' WHERE id = ?", [entry.id]),
      ).rejects.toMatchObject({ code: SqlState.RestrictViolation });
    });

    it('DELETE no ledger falha com restrict_violation', async () => {
      const { entry } = await processedBetWithEntry();

      await expect(
        db.execute('DELETE FROM wallet_ledger_entries WHERE id = ?', [entry.id]),
      ).rejects.toMatchObject({ code: SqlState.RestrictViolation });
    });

    it('TRUNCATE no ledger falha com restrict_violation', async () => {
      await processedBetWithEntry();

      await expect(db.execute('TRUNCATE wallet_ledger_entries')).rejects.toMatchObject({
        code: SqlState.RestrictViolation,
      });
    });
  });

  describe('inbox_messages', () => {
    it('o mesmo (consumer_name, message_id) falha com unique violation', async () => {
      const message = {
        consumer_name: 'wager-consumer',
        message_id: `msg-${newId()}`,
        payload_hash: 'hash',
        received_at: AT,
      };
      await insert('inbox_messages', message);

      await expect(insert('inbox_messages', message)).rejects.toMatchObject({
        code: SqlState.UniqueViolation,
      });
    });
  });
});
