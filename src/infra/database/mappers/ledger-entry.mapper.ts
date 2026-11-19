import { Money } from '../../../domain/shared/money.js';
import { LedgerDirection } from '../../../domain/wallet/ledger-direction.js';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry.js';
import type { LedgerEntryRecord } from '../records/ledger-entry.record.js';
import { parseEnum } from './parse-enum.js';

export const LedgerEntryMapper = {
  toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
    const money = (amount: string) => Money.from({ amount, currency: record.currency });

    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: parseEnum(LedgerDirection, record.direction, 'direction'),
      money: money(record.amount),
      balanceBefore: money(record.balanceBefore),
      balanceAfter: money(record.balanceAfter),
      createdAt: record.createdAt,
    });
  },

  toRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
    return {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toString(),
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      createdAt: entry.createdAt,
    };
  },
};
