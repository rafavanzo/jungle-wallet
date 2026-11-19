import { MikroORM } from '@mikro-orm/postgresql';

import {
  buildOrmConfig,
  requireDatabaseUrl,
} from '../../../src/infra/database/mikro-orm.config.js';

/** Códigos SQLSTATE do Postgres. Estáveis entre versões, ao contrário das mensagens. */
export const SqlState = {
  CheckViolation: '23514',
  UniqueViolation: '23505',
  ForeignKeyViolation: '23503',
  RestrictViolation: '23001',
} as const;

export interface TestDatabase {
  orm: MikroORM;
  execute<T = Record<string, unknown>[]>(sql: string, params?: readonly unknown[]): Promise<T>;
  close(): Promise<void>;
}

/**
 * Conecta no banco de testes (DATABASE_TEST_URL) e aplica as migrations
 * pendentes. Recusa qualquer banco cujo nome não termine em `_test`.
 */
export async function openTestDatabase(): Promise<TestDatabase> {
  const url = testDatabaseUrl();
  const orm = await MikroORM.init(buildOrmConfig(url));
  await orm.migrator.up();
  return wrap(orm, () => orm.close(true));
}

/**
 * Cria um banco vazio só para um arquivo de teste, com as migrations aplicadas,
 * e o apaga no `close()`. Usado nos testes que rodam o down() das migrations,
 * para que eles não dependam dos dados acumulados no banco de testes.
 */
export async function openThrowawayTestDatabase(): Promise<TestDatabase> {
  const baseUrl = testDatabaseUrl();
  const suffix = Bun.randomUUIDv7().replaceAll('-', '').slice(-12);
  const databaseName = `jungle_wallet_migrations_${suffix}_test`;

  const admin = await MikroORM.init(buildOrmConfig(baseUrl));
  await admin.em.getConnection().execute(`CREATE DATABASE ${databaseName}`);

  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  const orm = await MikroORM.init(buildOrmConfig(url.toString()));
  await orm.migrator.up();

  return wrap(orm, async () => {
    await orm.close(true);
    await admin.em.getConnection().execute(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await admin.close(true);
  });
}

function testDatabaseUrl(): string {
  const url = requireDatabaseUrl('DATABASE_TEST_URL');
  const databaseName = new URL(url).pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Recusando rodar testes de integração no banco "${databaseName}"`);
  }
  return url;
}

function wrap(orm: MikroORM, close: () => Promise<void>): TestDatabase {
  const connection = orm.em.getConnection();
  return {
    orm,
    execute: <T>(sql: string, params: readonly unknown[] = []) =>
      connection.execute(sql, params) as Promise<T>,
    close,
  };
}
