import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry.js';

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /**
   * Lançamentos da wallet em ordem cronológica (o id é UUID v7). 
   * `afterId` é o cursor: devolve só os lançamentos posteriores a ele.
   */
  listByWallet(
    walletId: string,
    afterId: string | undefined,
    limit: number,
  ): Promise<WalletLedgerEntry[]>;
}
