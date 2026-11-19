import { describe, expect, it } from 'bun:test';

import { CurrencyMismatchError, InvalidAmountError } from '../shared/domain-error.js';
import { Money } from '../shared/money.js';
import { LedgerDirection } from './ledger-direction.js';
import { WalletLedgerEntry, type WalletLedgerEntryProps } from './wallet-ledger-entry.js';
import { UnbalancedLedgerEntryError } from './wallet-errors.js';

const CREATED_AT = new Date('2026-11-19T10:00:00.000Z');

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });
const negativeBrl = (amount: string): Money => Money.zero('BRL').subtract(brl(amount));

const entryProps = (overrides: Partial<WalletLedgerEntryProps> = {}): WalletLedgerEntryProps => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Credit,
  money: brl('10.00'),
  balanceBefore: brl('0.00'),
  balanceAfter: brl('10.00'),
  createdAt: CREATED_AT,
  ...overrides,
});

describe('WalletLedgerEntry', () => {
  describe('create', () => {
    it('cria um DEBIT válido', () => {
      const entry = WalletLedgerEntry.create(
        entryProps({
          direction: LedgerDirection.Debit,
          money: brl('25.00'),
          balanceBefore: brl('100.00'),
          balanceAfter: brl('75.00'),
        }),
      );

      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.money.toString()).toBe('25.00');
      expect(entry.balanceBefore.toString()).toBe('100.00');
      expect(entry.balanceAfter.toString()).toBe('75.00');
      expect(entry.isBalanced()).toBe(true);
    });

    it('cria um CREDIT válido', () => {
      const entry = WalletLedgerEntry.create(entryProps());

      expect(entry.id).toBe('entry-1');
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.transactionId).toBe('tx-1');
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.balanceBefore.toString()).toBe('0.00');
      expect(entry.balanceAfter.toString()).toBe('10.00');
      expect(entry.createdAt).toEqual(CREATED_AT);
      expect(entry.isBalanced()).toBe(true);
    });

    it.each([
      [LedgerDirection.Debit, '10.00', '1.00', '8.00'],
      [LedgerDirection.Credit, '10.00', '1.00', '12.00'],
    ])('rejeita aritmética errada em %p: %p ± %p ≠ %p', (direction, before, money, after) => {
      const props = entryProps({
        direction,
        money: brl(money),
        balanceBefore: brl(before),
        balanceAfter: brl(after),
      });

      expect(() => WalletLedgerEntry.create(props)).toThrow(UnbalancedLedgerEntryError);
    });

    it.each([
      ['zero', brl('0.00')],
      ['negativo', negativeBrl('1.00')],
    ])('rejeita money %s', (_label, money) => {
      const props = entryProps({ money, balanceBefore: brl('10.00'), balanceAfter: brl('10.00') });

      expect(() => WalletLedgerEntry.create(props)).toThrow(InvalidAmountError);
    });

    it('rejeita moedas diferentes', () => {
      const props = entryProps({
        money: usd('1.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: brl('11.00'),
      });

      expect(() => WalletLedgerEntry.create(props)).toThrow(CurrencyMismatchError);
    });

    it('rejeita balanceAfter negativo', () => {
      const props = entryProps({
        direction: LedgerDirection.Debit,
        money: brl('11.00'),
        balanceBefore: brl('10.00'),
        balanceAfter: negativeBrl('1.00'),
      });

      expect(() => WalletLedgerEntry.create(props)).toThrow(UnbalancedLedgerEntryError);
    });

    it('aceita crédito exatamente no limite máximo do Money', () => {
      const entry = WalletLedgerEntry.create(
        entryProps({
          money: brl('0.01'),
          balanceBefore: brl('999999999999999999.98'),
          balanceAfter: brl('999999999999999999.99'),
        }),
      );

      expect(entry.isBalanced()).toBe(true);
    });
  });

  describe('rehydrate', () => {
    it('aceita um lançamento desbalanceado e isBalanced retorna false', () => {
      const entry = WalletLedgerEntry.rehydrate(
        entryProps({ money: brl('1.00'), balanceBefore: brl('10.00'), balanceAfter: brl('99.00') }),
      );

      expect(entry.isBalanced()).toBe(false);
    });

    it('isBalanced retorna false com moedas divergentes, sem lançar erro', () => {
      const entry = WalletLedgerEntry.rehydrate(
        entryProps({ money: usd('1.00'), balanceBefore: brl('10.00'), balanceAfter: brl('11.00') }),
      );

      expect(() => entry.isBalanced()).not.toThrow();
      expect(entry.isBalanced()).toBe(false);
    });
  });

  describe('imutabilidade', () => {
    it('atribuir a um campo lança TypeError', () => {
      const entry = WalletLedgerEntry.create(entryProps());
      const writable = entry as unknown as { money: Money };

      expect(() => {
        writable.money = brl('999.00');
      }).toThrow(TypeError);
      expect(entry.money.toString()).toBe('10.00');
    });

    it('alterar o Date devolvido não altera o lançamento', () => {
      const entry = WalletLedgerEntry.create(entryProps());

      entry.createdAt.setFullYear(2000);

      expect(entry.createdAt.getFullYear()).not.toBe(2000);
    });

    it('alterar o Date passado na criação não altera o lançamento', () => {
      const at = new Date(CREATED_AT);
      const entry = WalletLedgerEntry.create(entryProps({ createdAt: at }));

      at.setFullYear(2000);

      expect(entry.createdAt).toEqual(CREATED_AT);
    });
  });
});
