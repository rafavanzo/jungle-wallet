import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import { StaleUpdateError } from '../../../application/ports/persistence-errors.js';
import type { WalletRepository } from '../../../application/ports/wallet-repository.js';
import type { Wallet } from '../../../domain/wallet/wallet.js';
import { WalletMapper } from '../mappers/wallet.mapper.js';
import { WalletRecord } from '../records/wallet.record.js';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async lockById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id }, { disableIdentityMap: true });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletRecord, WalletMapper.toRecord(wallet));
  }

  async update(wallet: Wallet, expectedPreviousVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedPreviousVersion },
      {
        balance: wallet.balance.toString(),
        version: wallet.version,
        updatedAt: wallet.updatedAt,
      },
    );
    if (affected === 0) {
      throw new StaleUpdateError(
        `Wallet ${wallet.id} não está mais na version ${expectedPreviousVersion}`,
      );
    }
  }
}
