import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

import { InboxMessageSchema } from './records/inbox-message.record.js';
import { LedgerEntrySchema } from './records/ledger-entry.record.js';
import { OutboxMessageSchema } from './records/outbox-message.record.js';
import { WagerTransactionSchema } from './records/wager-transaction.record.js';
import { WalletSchema } from './records/wallet.record.js';

const MIGRATIONS_PATH = `${import.meta.dirname}/migrations`;

export function buildOrmConfig(clientUrl: string) {
  return defineConfig({
    clientUrl,
    // Registros de persistência (EntitySchema), separados das classes de domínio.
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      LedgerEntrySchema,
      OutboxMessageSchema,
      InboxMessageSchema,
    ],
    extensions: [Migrator],
    migrations: {
      // O Bun executa TypeScript direto: as migrations .ts são carregadas da pasta.
      path: MIGRATIONS_PATH,
      pathTs: MIGRATIONS_PATH,
      glob: '!(*.d).{js,ts}',
      // Cada migration numa transação, e o lote inteiro tudo-ou-nada: uma falha
      // no meio não deixa o schema pela metade.
      transactional: true,
      allOrNothing: true,
      // O schema é escrito à mão nas migrations; não há snapshot gerado a partir de entidades.
      snapshot: false,
      snapshotOnMigrate: false,
    },
  });
}

export function requireDatabaseUrl(variable = 'DATABASE_URL'): string {
  const url = process.env[variable];
  if (!url) {
    throw new Error(`Variável de ambiente ${variable} não definida`);
  }
  return url;
}
