import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';

const MIGRATIONS_PATH = `${import.meta.dirname}/migrations`;

export function buildOrmConfig(clientUrl: string) {
  return defineConfig({
    clientUrl,
    entities: [],
    discovery: { warnWhenNoEntities: false },
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
