import { MikroORM } from '@mikro-orm/postgresql';

import { buildOrmConfig, requireDatabaseUrl } from './mikro-orm.config.js';

/**
 * Executa as migrations sem o CLI do MikroORM (o Bun roda TypeScript direto).
 *
 *   bun run db:migrate    aplica as migrations pendentes
 *   bun run db:rollback   desfaz a última migration
 */
const command = process.argv[2];
if (command !== 'up' && command !== 'down') {
  console.error('Uso: bun src/infra/database/migrate.ts <up|down>');
  process.exit(1);
}

const orm = await MikroORM.init(buildOrmConfig(requireDatabaseUrl()));

try {
  const executed = command === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  const verb = command === 'up' ? 'aplicada' : 'revertida';

  if (executed.length === 0) {
    console.log('Nenhuma migration para executar.');
  }
  for (const migration of executed) {
    console.log(`Migration ${verb}: ${migration.name}`);
  }
} finally {
  await orm.close(true);
}
