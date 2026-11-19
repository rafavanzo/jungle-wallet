import { IsolationLevel } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';

import type {
  ReconciliationReader,
  ReconciliationSnapshot,
} from '../../application/ports/reconciliation-reader.js';
import { translateDatabaseError } from './database-error-translator.js';

interface Row {
  currency: string;
  stored: string;
  calculated: string;
  difference: string;
  checked: number;
}

/**
 * REPEATABLE READ READ ONLY: wallet e lançamentos vêm do mesmo snapshot, sem
 * bloquear as escritas concorrentes. A conta é feita em NUMERIC, no banco.
 */
export class MikroOrmReconciliationReader implements ReconciliationReader {
  constructor(private readonly orm: MikroORM) {}

  async read(walletId: string): Promise<ReconciliationSnapshot | undefined> {
    try {
      const [row] = await this.orm.em.fork().transactional(
        (em) =>
          em.execute<Row[]>(
            `SELECT w.currency,
                    w.balance::text AS stored,
                    sums.calculated::text AS calculated,
                    (w.balance - sums.calculated)::numeric(20,2)::text AS difference,
                    sums.checked
               FROM wallets w
              CROSS JOIN LATERAL (
                SELECT (COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'CREDIT'), 0)
                      - COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'DEBIT'), 0)
                       )::numeric(20,2) AS calculated,
                       COUNT(e.id)::int AS checked
                  FROM wallet_ledger_entries e
                 WHERE e.wallet_id = w.id
              ) sums
              WHERE w.id = ?`,
            [walletId],
          ),
        { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
      );
      if (!row) {
        return undefined;
      }
      return {
        currency: row.currency,
        storedBalance: row.stored,
        calculatedBalance: row.calculated,
        difference: row.difference,
        checkedEntries: row.checked,
      };
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
