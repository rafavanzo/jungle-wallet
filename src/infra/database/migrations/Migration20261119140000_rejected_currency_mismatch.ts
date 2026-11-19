import { Migration } from '@mikro-orm/migrations';

/**
 * Permite persistir uma transação REJECTED por CURRENCY_MISMATCH (operação em
 * USD numa wallet BRL), que a FK composta (wallet_id, currency) impedia.
 *
 * - A transação passa a ter FK simples para a wallet. O ledger continua com a
 *   FK composta: nenhum lançamento em moeda diferente da wallet é possível.
 * - O saldo resultante ganha moeda própria, sempre a da wallet, garantida por
 *   FK composta (wallet_id, resulting_balance_currency).
 */
export class Migration20261119140000RejectedCurrencyMismatch extends Migration {
  override name = 'Migration20261119140000_rejected_currency_mismatch';

  override up(): void {
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT fk_wager_tx_wallet_currency;`);
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT fk_wager_tx_wallet FOREIGN KEY (wallet_id) REFERENCES wallets (id);
    `);

    this.addSql(
      `ALTER TABLE wager_transactions ADD COLUMN resulting_balance_currency char(3) NULL;`,
    );
    // Backfill das linhas existentes. O trigger de imutabilidade de estados
    // terminais é desligado só durante este UPDATE, dentro da migration.
    this.addSql(`ALTER TABLE wager_transactions DISABLE TRIGGER trg_wager_tx_terminal_immutable;`);
    this.addSql(`
      UPDATE wager_transactions
         SET resulting_balance_currency = currency
       WHERE resulting_balance IS NOT NULL;
    `);
    this.addSql(`ALTER TABLE wager_transactions ENABLE TRIGGER trg_wager_tx_terminal_immutable;`);

    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT ck_wager_tx_resulting_balance_currency
          CHECK ((resulting_balance IS NULL) = (resulting_balance_currency IS NULL)),
        ADD CONSTRAINT fk_wager_tx_resulting_balance_currency
          FOREIGN KEY (wallet_id, resulting_balance_currency) REFERENCES wallets (id, currency);
    `);
  }

  override down(): void {
    this.addSql(`
      ALTER TABLE wager_transactions
        DROP CONSTRAINT fk_wager_tx_resulting_balance_currency,
        DROP CONSTRAINT ck_wager_tx_resulting_balance_currency,
        DROP COLUMN resulting_balance_currency;
    `);
    this.addSql(`ALTER TABLE wager_transactions DROP CONSTRAINT fk_wager_tx_wallet;`);
    // Falha alto se já houver transação gravada numa moeda diferente da wallet.
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT fk_wager_tx_wallet_currency
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency);
    `);
  }
}
