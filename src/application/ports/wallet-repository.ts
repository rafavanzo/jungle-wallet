import type { Wallet } from '../../domain/wallet/wallet.js';

export interface WalletRepository {
  /**
   * Lê a wallet com lock exclusivo (SELECT ... FOR UPDATE) até o fim da
   * transação. Toda operação que altera o saldo passa por aqui.
   */
  lockById(id: string): Promise<Wallet | undefined>;
  findById(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /** Grava saldo, version e updatedAt só se a version no banco for a esperada. */
  update(wallet: Wallet, expectedPreviousVersion: number): Promise<void>;
}
