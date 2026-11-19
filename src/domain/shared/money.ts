import { CurrencyMismatchError, InvalidMoneyError, MoneyOverflowError } from './domain-error.js';

/** Parte inteira + 0 a 2 casas decimais. Sem sinal, espaços, vírgula ou expoente. */
const AMOUNT_PATTERN = /^(\d+)(?:\.(\d{1,2}))?$/;

/** Código ISO-4217. */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const CENTS_PER_UNIT = 100n;

/** Maior valor que cabe em NUMERIC(20,2): 999999999999999999.99. */
const MAX_CENTS = 10n ** 20n - 1n;

export interface MoneyProps {
  amount: string;
  currency: string;
}

export interface MoneyJSON {
  amount: string;
  currency: string;
}

/**
 * Valor monetário imutável com escala fixa de 2 casas.
 *
 * Internamente o valor é um bigint em centavos: a aritmética é inteira, então
 * não existe arredondamento nem erro de ponto flutuante. O valor nunca passa
 * por `number`.
 *
 * Aceita negativos internamente (resultado de `subtract`/`negate`). Impedir
 * saldo negativo é regra da Wallet; a rejeição de negativos vale só em `from`.
 */
export class Money {
  private readonly cents: bigint;
  readonly currency: string;

  private constructor(cents: bigint, currency: string) {
    this.cents = cents;
    this.currency = currency;
  }

  /**
   * Única porta de entrada a partir de strings (contratos de API e eventos).
   * Aceita de 0 a 2 casas decimais e normaliza: "25" e "25.5" viram "25.00" e "25.50".
   */
  static from({ amount, currency }: MoneyProps): Money {
    Money.assertValidCurrency(currency);

    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('O valor monetário deve ser uma string decimal');
    }

    const match = AMOUNT_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(`Valor monetário inválido: "${amount}"`);
    }

    const [, integerPart = '0', fractionPart = ''] = match;
    const cents = BigInt(integerPart) * CENTS_PER_UNIT + BigInt(fractionPart.padEnd(2, '0'));

    if (cents > MAX_CENTS) {
      throw new InvalidMoneyError(`Valor monetário acima do máximo suportado: "${amount}"`);
    }

    return new Money(cents, currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(0n, currency);
  }

  /**
   * Fábrica dos resultados de operações. Valida o limite de NUMERIC(20,2) em
   * valor absoluto, para que um estouro (inclusive negativo) seja um erro de
   * domínio previsível e não uma falha no INSERT.
   */
  private static ofCents(cents: bigint, currency: string): Money {
    const abs = cents < 0n ? -cents : cents;
    if (abs > MAX_CENTS) {
      throw new MoneyOverflowError('Resultado acima do valor máximo suportado');
    }
    return new Money(cents, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofCents(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.ofCents(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return Money.ofCents(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.cents === other.cents && this.currency === other.currency;
  }

  /** Sempre com 2 casas, inclusive em negativos: "25.00", "-5.00". */
  toString(): string {
    // Formata o valor absoluto e põe o sinal no fim: em bigint, -5n / 100n é 0n
    // e o sinal se perderia na parte inteira.
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const integer = abs / CENTS_PER_UNIT;
    const fraction = (abs % CENTS_PER_UNIT).toString().padStart(2, '0');
    return `${negative ? '-' : ''}${integer}.${fraction}`;
  }

  toJSON(): MoneyJSON {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(
        `Moedas diferentes: ${this.currency} e ${other.currency}`,
      );
    }
  }

  private static assertValidCurrency(currency: string): void {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Moeda inválida: "${String(currency)}"`);
    }
  }
}
