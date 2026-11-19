import { describe, expect, it } from 'bun:test';

import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from './domain-error.js';
import { Money } from './money.js';

const MAX_AMOUNT = '999999999999999999.99';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string): Money => Money.from({ amount, currency: 'USD' });

describe('Money', () => {
  describe('validação de entrada', () => {
    it.each([
      ['25.00', '25.00'],
      ['0.00', '0.00'],
      ['25', '25.00'],
      ['25.5', '25.50'],
      ['007.50', '7.50'],
    ])('aceita %p e normaliza para %p', (amount, expected) => {
      expect(brl(amount).toString()).toBe(expected);
    });

    it.each([
      '',
      'NaN',
      'Infinity',
      '1e3',
      '10.123',
      '-5.00',
      '10,00',
      ' 10.00',
      '.50',
      '10.',
      '+10.00',
      '-0.00',
      'abc',
    ])('rejeita o valor %p', (amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it.each(['brl', 'BR', ''])('rejeita a moeda %p', (currency) => {
      expect(() => Money.from({ amount: '10.00', currency })).toThrow(InvalidMoneyError);
    });

    it('zero rejeita moeda inválida', () => {
      expect(() => Money.zero('brl')).toThrow(InvalidMoneyError);
    });

    it('rejeita valor que não é string, como um number vindo de JSON', () => {
      const amount = 25.5 as unknown as string;
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    it('aceita o máximo de NUMERIC(20,2) e rejeita acima dele', () => {
      expect(brl(MAX_AMOUNT).toString()).toBe(MAX_AMOUNT);
      expect(() => brl('1000000000000000000.00')).toThrow(InvalidMoneyError);
    });

    it('expõe um código de erro estável', () => {
      expect(() => brl('abc')).toThrow(expect.objectContaining({ code: 'INVALID_MONEY' }));
    });
  });

  describe('escala e arredondamento', () => {
    it('soma sem erro de ponto flutuante: 10.10 + 0.20 = 10.30', () => {
      expect(brl('10.10').add(brl('0.20')).toString()).toBe('10.30');
    });

    it('rejeita mais de 2 casas em vez de arredondar', () => {
      expect(() => brl('10.005')).toThrow(InvalidMoneyError);
    });

    it('formata sempre com 2 casas, inclusive em negativos', () => {
      expect(brl('5').toString()).toBe('5.00');
      expect(brl('1.00').subtract(brl('6.00')).toString()).toBe('-5.00');
      expect(brl('0.00').subtract(brl('0.05')).toString()).toBe('-0.05');
    });
  });

  describe('operações', () => {
    it('é imutável: add não altera a instância original', () => {
      const a = brl('10.00');
      const result = a.add(brl('5.00'));

      expect(a.toString()).toBe('10.00');
      expect(result.toString()).toBe('15.00');
      expect(result).not.toBe(a);
    });

    it('subtract preserva a moeda', () => {
      const result = usd('10.00').subtract(usd('2.50'));

      expect(result.toString()).toBe('7.50');
      expect(result.currency).toBe('USD');
    });

    it('negate inverte o sinal e preserva a moeda', () => {
      const result = usd('7.50').negate();

      expect(result.toString()).toBe('-7.50');
      expect(result.currency).toBe('USD');
      expect(result.negate().toString()).toBe('7.50');
    });

    it('negate de zero não gera "-0.00"', () => {
      expect(brl('0.00').negate().toString()).toBe('0.00');
    });

    it('lança AMOUNT_OUT_OF_RANGE quando o resultado passa do limite', () => {
      expect(() => brl(MAX_AMOUNT).add(brl('0.01'))).toThrow(MoneyOverflowError);
      expect(() => brl('0.00').subtract(brl(MAX_AMOUNT)).subtract(brl('0.01'))).toThrow(
        expect.objectContaining({ code: 'AMOUNT_OUT_OF_RANGE' }),
      );
    });
  });

  describe('comparações', () => {
    it('isZero', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(brl('0.01').isZero()).toBe(false);
    });

    it('isPositive e isNegative', () => {
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.00').isPositive()).toBe(false);
      expect(brl('1.00').subtract(brl('2.00')).isNegative()).toBe(true);
      expect(brl('0.00').isNegative()).toBe(false);
    });

    it('isLessThan', () => {
      expect(brl('1.99').isLessThan(brl('2.00'))).toBe(true);
      expect(brl('2.00').isLessThan(brl('2.00'))).toBe(false);
      expect(brl('2.01').isLessThan(brl('2.00'))).toBe(false);
    });

    it('equals compara valor normalizado e moeda', () => {
      expect(brl('25').equals(brl('25.00'))).toBe(true);
      expect(brl('25.00').equals(brl('25.01'))).toBe(false);
      expect(brl('25.00').equals(usd('25.00'))).toBe(false);
    });
  });

  describe('conflito de moeda', () => {
    it('add com moedas diferentes lança CurrencyMismatchError', () => {
      expect(() => brl('1.00').add(usd('1.00'))).toThrow(CurrencyMismatchError);
    });

    it('subtract com moedas diferentes lança CurrencyMismatchError', () => {
      expect(() => brl('1.00').subtract(usd('1.00'))).toThrow(CurrencyMismatchError);
    });

    it('isLessThan com moedas diferentes lança CurrencyMismatchError', () => {
      expect(() => brl('1.00').isLessThan(usd('1.00'))).toThrow(
        expect.objectContaining({ code: 'CURRENCY_MISMATCH' }),
      );
    });
  });

  describe('serialização', () => {
    it('JSON.stringify produz amount como string com 2 casas', () => {
      expect(JSON.stringify(brl('25'))).toBe('{"amount":"25.00","currency":"BRL"}');
    });
  });
});
