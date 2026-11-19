import { describe, expect, it } from 'bun:test';

import {
  CurrencyMismatchError,
  InvalidAmountError,
  MoneyOverflowError,
} from '../shared/domain-error.js';
import { Money } from '../shared/money.js';
import { LedgerDirection } from './ledger-direction.js';
import { Wallet, type BalanceMovementProps } from './wallet.js';
import type { WalletLedgerEntry } from './wallet-ledger-entry.js';
import { InsufficientFundsError } from './wallet-errors.js';

const OPENED_AT = new Date('2026-11-19T10:00:00.000Z');
const MOVED_AT = new Date('2026-11-19T11:00:00.000Z');
const MAX_AMOUNT = '999999999999999999.99';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

const openWallet = (initialBalance: Money, at: Date = OPENED_AT) =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance,
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    at,
  });

const movement = (money: Money, seq = 1): BalanceMovementProps => ({
  money,
  transactionId: `tx-${seq}`,
  entryId: `entry-${seq}`,
  at: MOVED_AT,
});

const snapshot = (wallet: Wallet) => ({
  balance: wallet.balance.toString(),
  version: wallet.version,
  updatedAt: wallet.updatedAt.toISOString(),
});

describe('Wallet', () => {
  describe('open', () => {
    it('abre com saldo inicial, version 1 e lançamento CREDIT de 0.00 até o saldo', () => {
      const { wallet, openingEntry } = openWallet(brl('1000.00'));

      expect(wallet.id).toBe('wallet-1');
      expect(wallet.playerId).toBe('player-1');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.toString()).toBe('1000.00');
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toEqual(OPENED_AT);
      expect(wallet.updatedAt).toEqual(OPENED_AT);

      expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry?.transactionId).toBe('tx-opening');
      expect(openingEntry?.id).toBe('entry-opening');
      expect(openingEntry?.walletId).toBe('wallet-1');
      expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
      expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
      expect(openingEntry?.money.toString()).toBe('1000.00');
    });

    it('abre com saldo zero, version 1 e sem lançamento', () => {
      const { wallet, openingEntry } = openWallet(brl('0.00'));

      expect(wallet.balance.toString()).toBe('0.00');
      expect(wallet.version).toBe(1);
      expect(openingEntry).toBeUndefined();
    });

    it('rejeita saldo inicial negativo', () => {
      const negative = Money.zero('BRL').subtract(brl('1.00'));

      expect(() => openWallet(negative)).toThrow(InvalidAmountError);
    });
  });

  describe('debit', () => {
    it('debita 25.00 de 1000.00 e devolve o lançamento DEBIT', () => {
      const { wallet } = openWallet(brl('1000.00'));

      const entry = wallet.debit(movement(brl('25.00')));

      expect(wallet.balance.toString()).toBe('975.00');
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(MOVED_AT);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.transactionId).toBe('tx-1');
      expect(entry.balanceBefore.toString()).toBe('1000.00');
      expect(entry.balanceAfter.toString()).toBe('975.00');
      expect(entry.money.toString()).toBe('25.00');
      expect(entry.isBalanced()).toBe(true);
    });

    it('debita o saldo exato e zera a carteira', () => {
      const { wallet } = openWallet(brl('50.00'));

      wallet.debit(movement(brl('50.00')));

      expect(wallet.balance.toString()).toBe('0.00');
    });

    it('rejeita débito sem saldo e mantém saldo, version e updatedAt', () => {
      const { wallet } = openWallet(brl('10.00'));
      const before = snapshot(wallet);

      expect(() => wallet.debit(movement(brl('10.01')))).toThrow(InsufficientFundsError);
      expect(snapshot(wallet)).toEqual(before);
    });
  });

  describe('credit', () => {
    it('credita, incrementa a version e devolve o lançamento CREDIT', () => {
      const { wallet } = openWallet(brl('70.00'));

      const entry = wallet.credit(movement(brl('5.50')));

      expect(wallet.balance.toString()).toBe('75.50');
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.balanceBefore.toString()).toBe('70.00');
      expect(entry.balanceAfter.toString()).toBe('75.50');
    });
  });

  describe('falha não altera estado', () => {
    it.each([
      ['débito sem saldo', (w: Wallet) => w.debit(movement(brl('10.01'))), InsufficientFundsError],
      ['débito de zero', (w: Wallet) => w.debit(movement(brl('0.00'))), InvalidAmountError],
      ['crédito de zero', (w: Wallet) => w.credit(movement(brl('0.00'))), InvalidAmountError],
      [
        'débito em outra moeda',
        (w: Wallet) => w.debit(movement(usd('1.00'))),
        CurrencyMismatchError,
      ],
      [
        'crédito em outra moeda',
        (w: Wallet) => w.credit(movement(usd('1.00'))),
        CurrencyMismatchError,
      ],
      [
        'crédito que estoura o limite',
        (w: Wallet) => w.credit(movement(brl(MAX_AMOUNT))),
        MoneyOverflowError,
      ],
    ] as const)('%s lança erro e mantém a carteira intacta', (_label, operation, error) => {
      const { wallet } = openWallet(brl('10.00'));
      const before = snapshot(wallet);

      expect(() => operation(wallet)).toThrow(error);
      expect(snapshot(wallet)).toEqual(before);
    });

    it('uma sequência de falhas não altera saldo, version nem updatedAt', () => {
      const { wallet } = openWallet(brl('10.00'));
      const before = snapshot(wallet);

      expect(() => wallet.debit(movement(brl('10.01')))).toThrow(InsufficientFundsError);
      expect(() => wallet.debit(movement(brl('0.00')))).toThrow(InvalidAmountError);
      expect(() => wallet.credit(movement(brl('0.00')))).toThrow(InvalidAmountError);
      expect(() => wallet.debit(movement(usd('1.00')))).toThrow(CurrencyMismatchError);
      expect(() => wallet.credit(movement(brl(MAX_AMOUNT)))).toThrow(MoneyOverflowError);

      expect(snapshot(wallet)).toEqual(before);
    });
  });

  describe('cenário de concorrência em memória', () => {
    it('com saldo 100.00, o primeiro débito de 80.00 passa e o segundo falha', () => {
      const { wallet } = openWallet(brl('100.00'));

      wallet.debit(movement(brl('80.00'), 1));

      expect(() => wallet.debit(movement(brl('80.00'), 2))).toThrow(InsufficientFundsError);
      expect(wallet.balance.toString()).toBe('20.00');
      expect(wallet.version).toBe(2);
    });
  });

  describe('rehydrate', () => {
    it('preserva saldo, version e datas sem revalidar', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: brl('5.00'),
        version: 7,
        createdAt: OPENED_AT,
        updatedAt: MOVED_AT,
      });

      expect(wallet.balance.toString()).toBe('5.00');
      expect(wallet.version).toBe(7);
      expect(wallet.createdAt).toEqual(OPENED_AT);
      expect(wallet.updatedAt).toEqual(MOVED_AT);
    });
  });

  describe('invariante saldo ↔ ledger', () => {
    it('a soma dos lançamentos devolvidos é igual ao saldo final', () => {
      const { wallet, openingEntry } = openWallet(brl('100.00'));
      const entries: WalletLedgerEntry[] = [
        ...(openingEntry ? [openingEntry] : []),
        wallet.debit(movement(brl('30.00'), 1)),
        wallet.credit(movement(brl('10.00'), 2)),
        wallet.debit(movement(brl('5.00'), 3)),
      ];

      const ledgerSum = entries.reduce(
        (sum, entry) =>
          entry.direction === LedgerDirection.Credit
            ? sum.add(entry.money)
            : sum.subtract(entry.money),
        Money.zero('BRL'),
      );

      expect(entries).toHaveLength(4);
      expect(ledgerSum.equals(wallet.balance)).toBe(true);
      expect(wallet.balance.toString()).toBe('75.00');
      expect(wallet.version).toBe(4);
    });
  });

  describe('cópia defensiva de datas', () => {
    it('alterar os Dates devolvidos não altera a carteira', () => {
      const { wallet } = openWallet(brl('10.00'));

      wallet.createdAt.setFullYear(2000);
      wallet.updatedAt.setFullYear(2000);

      expect(wallet.createdAt).toEqual(OPENED_AT);
      expect(wallet.updatedAt).toEqual(OPENED_AT);
    });

    it('alterar os Dates passados em open e debit não altera a carteira', () => {
      const openedAt = new Date(OPENED_AT);
      const movedAt = new Date(MOVED_AT);
      const { wallet } = openWallet(brl('10.00'), openedAt);
      wallet.debit({ ...movement(brl('1.00')), at: movedAt });

      openedAt.setFullYear(2000);
      movedAt.setFullYear(2000);

      expect(wallet.createdAt).toEqual(OPENED_AT);
      expect(wallet.updatedAt).toEqual(MOVED_AT);
    });
  });
});
