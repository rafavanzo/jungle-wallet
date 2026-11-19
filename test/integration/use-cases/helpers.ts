import { expect } from 'bun:test';

import type { Clock } from '../../../src/application/ports/clock.js';
import type { TestDatabase } from '../helpers/database.js';

export const NOW = new Date('2026-11-19T12:00:00.000Z');

export const fixedClock: Clock = { now: () => new Date(NOW) };

interface LedgerSummary {
  balance: string;
  ledger_sum: string;
  version: number;
  entries: string;
  opening_entries: string;
}

/**
 * Invariante final de todos os testes de caso de uso (seção 13): o saldo da
 * wallet é igual ao saldo reconstruído pelo ledger, e a version é 1 mais o
 * número de movimentos depois da abertura. Conferido direto em SQL.
 */
export async function assertLedgerConsistent(db: TestDatabase, walletId: string): Promise<void> {
  const [summary] = await db.execute<LedgerSummary[]>(
    `SELECT w.balance::text AS balance,
            w.version,
            COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::numeric(20,2)::text AS ledger_sum,
            COUNT(e.id)::text AS entries,
            COUNT(e.id) FILTER (WHERE t.kind = 'OPENING')::text AS opening_entries
       FROM wallets w
       LEFT JOIN wallet_ledger_entries e ON e.wallet_id = w.id
       LEFT JOIN wager_transactions t ON t.id = e.transaction_id
      WHERE w.id = ?
      GROUP BY w.id`,
    [walletId],
  );

  expect(summary).toBeDefined();
  expect(summary!.ledger_sum).toBe(summary!.balance);
  const movements = Number(summary!.entries) - Number(summary!.opening_entries);
  expect(summary!.version).toBe(1 + movements);
}

/** Tipos dos eventos na outbox ligados a uma transação, na ordem de gravação. */
export async function eventTypesForTransaction(
  db: TestDatabase,
  transactionId: string,
): Promise<string[]> {
  const rows = await db.execute<{ event_type: string }[]>(
    `SELECT event_type FROM outbox_messages
      WHERE payload -> 'data' ->> 'transactionId' = ?
      ORDER BY id`,
    [transactionId],
  );
  return rows.map((row) => row.event_type);
}

export async function ledgerEntriesForTransaction(
  db: TestDatabase,
  transactionId: string,
): Promise<{ direction: string; amount: string }[]> {
  return db.execute(
    'SELECT direction, amount::text AS amount FROM wallet_ledger_entries WHERE transaction_id = ?',
    [transactionId],
  );
}

export async function transactionStatus(
  db: TestDatabase,
  transactionId: string,
): Promise<string | undefined> {
  const [row] = await db.execute<{ status: string }[]>(
    'SELECT status FROM wager_transactions WHERE id = ?',
    [transactionId],
  );
  return row?.status;
}
