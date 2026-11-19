import type { EntityManager } from '@mikro-orm/postgresql';

import type { LedgerRepository } from '../../../application/ports/ledger-repository.js';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import { LedgerEntryMapper } from '../mappers/ledger-entry.mapper.js';
import { LedgerEntryRecord } from '../records/ledger-entry.record.js';

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, LedgerEntryMapper.toRecord(entry));
  }

  async listByWallet(
    walletId: string,
    afterId: string | undefined,
    limit: number,
  ): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntryRecord,
      afterId === undefined ? { walletId } : { walletId, id: { $gt: afterId } },
      { orderBy: { id: 'asc' }, limit, disableIdentityMap: true },
    );
    return records.map((record) => LedgerEntryMapper.toDomain(record));
  }
}
