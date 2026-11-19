import { copyDate } from '../shared/copy-date.js';
import { CurrencyMismatchError, InvalidAmountError } from '../shared/domain-error.js';
import type { Money } from '../shared/money.js';
import { LedgerDirection } from './ledger-direction.js';
import { UnbalancedLedgerEntryError } from './wallet-errors.js';

export interface WalletLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  /** Sempre positivo; o sentido vem de `direction`. */
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type WalletLedgerEntryState = WalletLedgerEntryProps;

/**
 * Lançamento do ledger: imutável e auditável.
 *
 * A imutabilidade é estrutural: `readonly` no tipo, `Object.freeze` em tempo de
 * execução e cópia defensiva da data (o freeze não congela um Date por dentro).
 * No banco, um trigger impede UPDATE e DELETE.
 */
export class WalletLedgerEntry {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  private readonly _createdAt: Date;

  private constructor(props: WalletLedgerEntryProps) {
    this.id = props.id;
    this.walletId = props.walletId;
    this.transactionId = props.transactionId;
    this.direction = props.direction;
    this.money = props.money;
    this.balanceBefore = props.balanceBefore;
    this.balanceAfter = props.balanceAfter;
    this._createdAt = copyDate(props.createdAt);
    Object.freeze(this);
  }

  /** Cria um lançamento novo validando moeda, sinal e aritmética. */
  static create(props: WalletLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;

    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new CurrencyMismatchError(
        `Moedas diferentes no lançamento: ${money.currency}, ${balanceBefore.currency} e ${balanceAfter.currency}`,
      );
    }

    if (!money.isPositive()) {
      throw new InvalidAmountError(`O valor do lançamento deve ser positivo: ${money.toString()}`);
    }

    if (balanceAfter.isNegative()) {
      throw new UnbalancedLedgerEntryError(
        `O saldo após o lançamento não pode ser negativo: ${balanceAfter.toString()}`,
      );
    }

    const entry = new WalletLedgerEntry(props);
    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `Lançamento desbalanceado: ${balanceBefore.toString()} ${props.direction} ${money.toString()} ≠ ${balanceAfter.toString()}`,
      );
    }

    return entry;
  }

  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(state);
  }

  get createdAt(): Date {
    return copyDate(this._createdAt);
  }

  /**
   * Recalcula a conta do lançamento. Usado no create e na reconciliação.
   *
   * O crédito é conferido como `balanceAfter - money === balanceBefore` (e não
   * `balanceBefore + money`) para não estourar o limite do Money em dados
   * reidratados próximos do máximo.
   */
  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }

    return this.direction === LedgerDirection.Debit
      ? this.balanceBefore.subtract(this.money).equals(this.balanceAfter)
      : this.balanceAfter.subtract(this.money).equals(this.balanceBefore);
  }
}
