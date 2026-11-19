import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';

import type {
  TransactionalRepositories,
  UnitOfWork,
} from '../../application/ports/unit-of-work.js';
import { translateDatabaseError } from './database-error-translator.js';
import { MikroOrmInboxRepository } from './repositories/mikro-orm-inbox.repository.js';
import { MikroOrmLedgerRepository } from './repositories/mikro-orm-ledger.repository.js';
import { MikroOrmOutboxRepository } from './repositories/mikro-orm-outbox.repository.js';
import { MikroOrmWagerTransactionRepository } from './repositories/mikro-orm-wager-transaction.repository.js';
import { MikroOrmWalletRepository } from './repositories/mikro-orm-wallet.repository.js';

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export interface UnitOfWorkOptions {
  /** Espera máxima por um lock antes de virar erro transitório. */
  lockTimeoutMs: number;
}

/**
 * Cada `run` usa um EntityManager novo (fork): Identity Map próprio, sem vazar
 * estado entre execuções, e igual no HTTP e no consumidor SQS.
 *
 * READ COMMITTED é intencional: depois de esperar pelo lock da wallet, cada
 * comando enxerga o que a outra execução acabou de commitar. O lock na linha já
 * serializa as operações; um isolamento maior só geraria erros de serialização.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly orm: MikroORM,
    options: UnitOfWorkOptions = { lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS },
  ) {
    // Validado porque SET LOCAL não aceita parâmetro e o valor vai interpolado.
    if (!Number.isInteger(options.lockTimeoutMs) || options.lockTimeoutMs <= 0) {
      throw new Error(`lockTimeoutMs inválido: ${options.lockTimeoutMs}`);
    }
    this.lockTimeoutMs = options.lockTimeoutMs;
  }

  async run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          await em.execute(`SET LOCAL lock_timeout = '${this.lockTimeoutMs}ms'`);
          return work(createRepositories(em));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}

function createRepositories(em: EntityManager): TransactionalRepositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmLedgerRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
    inbox: new MikroOrmInboxRepository(em),
  };
}
