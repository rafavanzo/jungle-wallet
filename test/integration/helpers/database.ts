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
 * pendentes. Recusa qualquer banco cujo nome não termine em `_test`, porque os
 * testes de migration rodam o down(), que apaga todas as tabelas.
 */
export async function openTestDatabase(): Promise<TestDatabase> {
  const url = requireDatabaseUrl('DATABASE_TEST_URL');
  const databaseName = new URL(url).pathname.slice(1);
  if (!databaseName.endsWith('_test')) {
    throw new Error(`Recusando rodar testes de integração no banco "${databaseName}"`);
  }

  const orm = await MikroORM.init(buildOrmConfig(url));
  await orm.migrator.up();
  const connection = orm.em.getConnection();

  return {
    orm,
    execute: <T>(sql: string, params: readonly unknown[] = []) =>
      connection.execute(sql, params) as Promise<T>,
    close: () => orm.close(true),
  };
}
