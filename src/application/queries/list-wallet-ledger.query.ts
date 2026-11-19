import { WalletNotFoundError } from '../errors/application-errors.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor.js';
import { type LedgerPageView, toLedgerEntryView } from './views.js';

export interface ListWalletLedgerInput {
  walletId: string;
  cursor: string | undefined;
  /** 1 a 100; validado na borda. */
  limit: number;
}

export class ListWalletLedgerQuery {
  constructor(private readonly uow: UnitOfWork) {}

  async execute({ walletId, cursor, limit }: ListWalletLedgerInput): Promise<LedgerPageView> {
    const afterId = cursor === undefined ? undefined : decodeLedgerCursor(cursor);

    const { exists, entries } = await this.uow.run(async ({ wallets, ledger }) => ({
      exists: (await wallets.findById(walletId)) !== undefined,
      // Um item a mais diz se existe próxima página, sem COUNT.
      entries: await ledger.listByWallet(walletId, afterId, limit + 1),
    }));
    if (!exists) {
      throw new WalletNotFoundError(`Wallet ${walletId} não encontrada`);
    }

    const page = entries.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toLedgerEntryView),
      nextCursor: entries.length > limit && last ? encodeLedgerCursor(last.id) : null,
    };
  }
}
