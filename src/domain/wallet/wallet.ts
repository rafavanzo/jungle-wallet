import { copyDate } from '../shared/copy-date.js';
import { CurrencyMismatchError, InvalidAmountError } from '../shared/domain-error.js';
import { Money } from '../shared/money.js';
import { LedgerDirection } from './ledger-direction.js';
import { WalletLedgerEntry } from './wallet-ledger-entry.js';
import { InsufficientFundsError } from './wallet-errors.js';

/** Campos persistidos da Wallet. */
export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** Id da transação interna OPENING que origina o saldo inicial. */
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface OpenWalletResult {
  wallet: Wallet;
  /** Lançamento CREDIT do saldo inicial; ausente quando o saldo inicial é zero. */
  openingEntry: WalletLedgerEntry | undefined;
}

export interface BalanceMovementProps {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

/**
 * Aggregate Root da carteira.
 *
 * O saldo só muda por `debit` e `credit`, e ambos devolvem o lançamento do
 * ledger já calculado. Assim é estruturalmente impossível alterar o saldo sem
 * gerar o lançamento correspondente.
 *
 * Ids e datas vêm de fora (camada de aplicação): o domínio não gera UUID nem
 * lê o relógio. A serialização entre processos é responsabilidade do lock no
 * banco; o agregado garante a consistência de cada operação.
 */
export class Wallet {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  private _balance: Money;
  private _version: number;
  private readonly _createdAt: Date;
  private _updatedAt: Date;

  private constructor(state: WalletState) {
    this.id = state.id;
    this.playerId = state.playerId;
    this.currency = state.currency;
    this._balance = state.balance;
    this._version = state.version;
    this._createdAt = copyDate(state.createdAt);
    this._updatedAt = copyDate(state.updatedAt);
  }

  /**
   * Abre a carteira com version 1. Se houver saldo inicial, devolve também o
   * lançamento CREDIT de 0.00 até o saldo inicial: abrir e creditar o saldo
   * inicial são um único fato de negócio, sem incrementar a version.
   */
  static open(props: OpenWalletProps): OpenWalletResult {
    const { id, playerId, initialBalance, at } = props;

    if (initialBalance.isNegative()) {
      throw new InvalidAmountError(
        `O saldo inicial não pode ser negativo: ${initialBalance.toString()}`,
      );
    }

    const openingEntry = initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          id: props.openingEntryId,
          walletId: id,
          transactionId: props.openingTransactionId,
          direction: LedgerDirection.Credit,
          money: initialBalance,
          balanceBefore: Money.zero(initialBalance.currency),
          balanceAfter: initialBalance,
          createdAt: at,
        })
      : undefined;

    const wallet = new Wallet({
      id,
      playerId,
      currency: initialBalance.currency,
      balance: initialBalance,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });

    return { wallet, openingEntry };
  }

  /** Reconstrói a partir do banco, sem validar. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state);
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return copyDate(this._createdAt);
  }

  get updatedAt(): Date {
    return copyDate(this._updatedAt);
  }

  debit(props: BalanceMovementProps): WalletLedgerEntry {
    this.assertValidMovement(props.money);

    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError(
        `Saldo insuficiente: saldo ${this._balance.toString()}, débito ${props.money.toString()}`,
      );
    }

    return this.applyMovement(LedgerDirection.Debit, props, this._balance.subtract(props.money));
  }

  credit(props: BalanceMovementProps): WalletLedgerEntry {
    this.assertValidMovement(props.money);

    // Money.add lança MoneyOverflowError se o novo saldo passar do limite.
    return this.applyMovement(LedgerDirection.Credit, props, this._balance.add(props.money));
  }

  private assertValidMovement(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `Moeda da operação (${money.currency}) difere da carteira (${this.currency})`,
      );
    }

    if (!money.isPositive()) {
      throw new InvalidAmountError(`O valor da operação deve ser positivo: ${money.toString()}`);
    }
  }

  /**
   * Cria o lançamento e só depois altera o estado. Qualquer falha (validação ou
   * create do lançamento) acontece antes, e a carteira continua intacta.
   */
  private applyMovement(
    direction: LedgerDirection,
    { money, transactionId, entryId, at }: BalanceMovementProps,
    balanceAfter: Money,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = copyDate(at);

    return entry;
  }
}
