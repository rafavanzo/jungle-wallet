import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. Escrito à mão: triggers, índices únicos parciais e CHECKs
 * compostos são parte das garantias e não podem ser gerados a partir de
 * entidades. Esta migration é a fonte da verdade do schema.
 */
export class Migration20261119120000InitialSchema extends Migration {
  override name = 'Migration20261119120000_initial_schema';

  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid          PRIMARY KEY,
        player_id   text          NOT NULL,
        currency    char(3)       NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2) NOT NULL CHECK (balance >= 0),
        version     integer       NOT NULL CHECK (version >= 1),
        created_at  timestamptz   NOT NULL,
        updated_at  timestamptz   NOT NULL,
        CONSTRAINT ux_wallets_player_currency UNIQUE (player_id, currency),
        CONSTRAINT ux_wallets_id_currency UNIQUE (id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid          PRIMARY KEY,
        provider_id                       text          NOT NULL,
        external_transaction_id           text          NOT NULL,
        idempotency_key                   text          NOT NULL,
        payload_hash                      text          NOT NULL,
        wallet_id                         uuid          NOT NULL,
        player_id                         text          NOT NULL,
        round_id                          text          NOT NULL,
        game_id                           text          NOT NULL,
        kind                              text          NOT NULL,
        amount                            numeric(20,2) NOT NULL CHECK (amount >= 0),
        currency                          char(3)       NOT NULL,
        reference_external_transaction_id text          NULL,
        reference_transaction_id          uuid          NULL,
        status                            text          NOT NULL,
        failure_code                      text          NULL,
        resulting_balance                 numeric(20,2) NULL CHECK (resulting_balance >= 0),
        reference_attempts                integer       NOT NULL DEFAULT 0,
        next_reference_attempt_at         timestamptz   NULL,
        created_at                        timestamptz   NOT NULL,
        processed_at                      timestamptz   NULL,

        CONSTRAINT ck_wager_tx_kind
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT ck_wager_tx_status
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        -- Só LOSS aceita valor zero.
        CONSTRAINT ck_wager_tx_positive_amount
          CHECK (kind = 'LOSS' OR amount > 0),
        -- Regra 1: REFUND e ROLLBACK exigem referência.
        CONSTRAINT ck_wager_tx_reversal_requires_reference
          CHECK (kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        -- Toda rejeição/falha tem código, e só elas têm.
        CONSTRAINT ck_wager_tx_failure_code
          CHECK ((status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)),
        -- Estado terminal se e somente se há processed_at.
        CONSTRAINT ck_wager_tx_processed_at
          CHECK ((status IN ('PROCESSED', 'REJECTED', 'FAILED')) = (processed_at IS NOT NULL)),
        -- Processada com referência exige o id interno resolvido. Sem isso, um
        -- NULL escaparia do índice de reversão única (NULLs não colidem).
        CONSTRAINT ck_wager_tx_processed_reference_resolved
          CHECK (
            status <> 'PROCESSED'
            OR reference_external_transaction_id IS NULL
            OR reference_transaction_id IS NOT NULL
          ),

        -- Idempotência persistente, no espaço de chaves de cada provedor.
        CONSTRAINT ux_wager_tx_idempotency UNIQUE (provider_id, idempotency_key),
        -- A mesma operação do provedor existe uma vez; também resolve referências.
        CONSTRAINT ux_wager_tx_external UNIQUE (provider_id, external_transaction_id),
        -- Alvo das FKs compostas que exigem a mesma wallet.
        CONSTRAINT ux_wager_tx_id_wallet UNIQUE (id, wallet_id),

        -- Moeda da transação igual à da wallet.
        CONSTRAINT fk_wager_tx_wallet_currency
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        -- A referência resolvida pertence à mesma wallet (regra 2).
        CONSTRAINT fk_wager_tx_reference_same_wallet
          FOREIGN KEY (reference_transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id)
      );
    `);

    // Cada transação é revertida no máximo uma vez, por qualquer tipo de reversão.
    // Uma reversão rejeitada não conta.
    this.addSql(`
      CREATE UNIQUE INDEX ux_wager_tx_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';
    `);
    this.addSql(`
      CREATE INDEX ix_wager_tx_pending_reference_due
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`CREATE INDEX ix_wager_tx_wallet ON wager_transactions (wallet_id);`);

    // Estados terminais não mudam mais.
    this.addSql(`
      CREATE FUNCTION forbid_terminal_transaction_update() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wager_transactions % is in terminal status %', OLD.id, OLD.status
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER trg_wager_tx_terminal_immutable
        BEFORE UPDATE ON wager_transactions
        FOR EACH ROW
        WHEN (OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED'))
        EXECUTE FUNCTION forbid_terminal_transaction_update();
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid          PRIMARY KEY,
        wallet_id       uuid          NOT NULL,
        transaction_id  uuid          NOT NULL,
        direction       text          NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount          numeric(20,2) NOT NULL CHECK (amount > 0),
        currency        char(3)       NOT NULL,
        balance_before  numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        created_at      timestamptz   NOT NULL,

        -- A mesma conta do isBalanced() do domínio.
        CONSTRAINT ck_ledger_arithmetic CHECK (
          (direction = 'DEBIT'  AND balance_after = balance_before - amount) OR
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
        ),
        -- No máximo um lançamento por transação e wallet.
        CONSTRAINT ux_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
        -- Moeda do lançamento igual à da wallet.
        CONSTRAINT fk_ledger_wallet_currency
          FOREIGN KEY (wallet_id, currency) REFERENCES wallets (id, currency),
        -- O lançamento pertence à mesma wallet da transação.
        CONSTRAINT fk_ledger_transaction_same_wallet
          FOREIGN KEY (transaction_id, wallet_id) REFERENCES wager_transactions (id, wallet_id)
      );
    `);
    // Paginação por cursor: UUID v7 é ordenável por tempo.
    this.addSql(`CREATE INDEX ix_ledger_wallet_cursor ON wallet_ledger_entries (wallet_id, id);`);

    // Ledger append-only: nem UPDATE, nem DELETE, nem TRUNCATE.
    this.addSql(`
      CREATE FUNCTION forbid_ledger_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP
          USING ERRCODE = 'restrict_violation';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_update_delete
        BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_truncate
        BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  text        NOT NULL,
        message_id     text        NOT NULL,
        payload_hash   text        NOT NULL,
        received_at    timestamptz NOT NULL,
        processed_at   timestamptz NULL,
        CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid        PRIMARY KEY,
        aggregate_id     text        NOT NULL,
        event_type       text        NOT NULL,
        payload          jsonb       NOT NULL,
        occurred_at      timestamptz NOT NULL,
        attempts         integer     NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz NOT NULL,
        published_at     timestamptz NULL,
        last_error       text        NULL
      );
    `);
    this.addSql(`
      CREATE INDEX ix_outbox_pending
        ON outbox_messages (next_attempt_at)
        WHERE published_at IS NULL;
    `);
  }

  override down(): void {
    this.addSql(`DROP TRIGGER trg_ledger_no_truncate ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER trg_ledger_no_update_delete ON wallet_ledger_entries;`);
    this.addSql(`DROP TRIGGER trg_wager_tx_terminal_immutable ON wager_transactions;`);
    this.addSql(`DROP FUNCTION forbid_ledger_mutation();`);
    this.addSql(`DROP FUNCTION forbid_terminal_transaction_update();`);
    this.addSql(`DROP TABLE outbox_messages;`);
    this.addSql(`DROP TABLE inbox_messages;`);
    this.addSql(`DROP TABLE wallet_ledger_entries;`);
    this.addSql(`DROP TABLE wager_transactions;`);
    this.addSql(`DROP TABLE wallets;`);
  }
}
