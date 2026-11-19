import { WalletNotFoundError } from '../errors/application-errors.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { toWalletView, type WalletView } from './views.js';

export class GetWalletQuery {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<WalletView> {
    const wallet = await this.uow.run(({ wallets }) => wallets.findById(walletId));
    if (!wallet) {
      throw new WalletNotFoundError(`Wallet ${walletId} não encontrada`);
    }
    return toWalletView(wallet);
  }
}
