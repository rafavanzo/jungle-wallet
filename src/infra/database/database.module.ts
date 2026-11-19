import { MikroORM } from '@mikro-orm/core';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver, type MikroORM as PostgreSqlMikroORM } from '@mikro-orm/postgresql';
import { Module } from '@nestjs/common';

import { CLOCK } from '../../application/ports/clock.js';
import { ID_GENERATOR } from '../../application/ports/id-generator.js';
import { UNIT_OF_WORK } from '../../application/ports/unit-of-work.js';
import { SystemClock } from '../system/system-clock.js';
import { UuidV7Generator } from '../system/uuid-v7-generator.js';
import { buildOrmConfig, requireDatabaseUrl } from './mikro-orm.config.js';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work.js';

/**
 * Liga as portas da aplicação às implementações com MikroORM. Os providers são
 * expostos por token (Symbol), porque interfaces não existem em runtime.
 */
@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      driver: PostgreSqlDriver,
      useFactory: () => ({
        ...buildOrmConfig(requireDatabaseUrl()),
        // Cada execução abre o próprio contexto via fork() na UnitOfWork.
        registerRequestContext: false,
      }),
    }),
  ],
  providers: [
    {
      provide: UNIT_OF_WORK,
      useFactory: (orm: PostgreSqlMikroORM) => new MikroOrmUnitOfWork(orm),
      inject: [MikroORM],
    },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
  ],
  exports: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
})
export class DatabaseModule {}
