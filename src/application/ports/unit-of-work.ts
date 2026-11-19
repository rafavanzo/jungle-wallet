import type { InboxRepository } from './inbox-repository.js';
import type { LedgerRepository } from './ledger-repository.js';
import type { OutboxRepository } from './outbox-repository.js';
import type { WagerTransactionRepository } from './wager-transaction-repository.js';
import type { WalletRepository } from './wallet-repository.js';

export interface TransactionalRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  outbox: OutboxRepository;
  inbox: InboxRepository;
}

/**
 * Fronteira transacional dos casos de uso. Tudo que `work` faz pelos
 * repositórios recebidos é confirmado junto, ou desfeito junto se ele lançar.
 * Os repositórios só existem dentro de `work`, então não há como usá-los fora
 * da transação por engano.
 *
 * Erros do banco saem já traduzidos (ver persistence-errors).
 */
export interface UnitOfWork {
  run<T>(work: (repositories: TransactionalRepositories) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');
