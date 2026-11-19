import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { openTestDatabase, type TestDatabase } from './helpers/database.js';

const SCHEMA_TABLES = [
  'inbox_messages',
  'outbox_messages',
  'wager_transactions',
  'wallet_ledger_entries',
  'wallets',
];
const SCHEMA_FUNCTIONS = ['forbid_ledger_mutation', 'forbid_terminal_transaction_update'];

let db: TestDatabase;

beforeAll(async () => {
  db = await openTestDatabase();
});

afterAll(async () => {
  // Garante o schema de volta mesmo se o teste falhar no meio.
  await db.orm.migrator.up();
  await db.close();
});

async function existingTables(): Promise<string[]> {
  const rows = await db.execute<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  return rows.map((row) => row.tablename).filter((name) => SCHEMA_TABLES.includes(name));
}

async function existingFunctions(): Promise<string[]> {
  const rows = await db.execute<{ proname: string }[]>(
    "SELECT proname FROM pg_proc WHERE proname LIKE 'forbid_%' ORDER BY proname",
  );
  return rows.map((row) => row.proname);
}

describe('migrations', () => {
  it('down() remove tabelas e funções, e up() recria tudo', async () => {
    expect(await existingTables()).toEqual(SCHEMA_TABLES);
    expect(await existingFunctions()).toEqual(SCHEMA_FUNCTIONS);

    await db.orm.migrator.down();

    expect(await existingTables()).toEqual([]);
    expect(await existingFunctions()).toEqual([]);

    await db.orm.migrator.up();

    expect(await existingTables()).toEqual(SCHEMA_TABLES);
    expect(await existingFunctions()).toEqual(SCHEMA_FUNCTIONS);
  });
});
