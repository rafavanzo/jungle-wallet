import { copyDate } from '../shared/copy-date.js';
import { InvalidAmountError } from '../shared/domain-error.js';
import type { Money } from '../shared/money.js';
import { LedgerDirection } from '../wallet/ledger-direction.js';
import { FailureCode } from './failure-code.js';
import { WagerTransactionKind } from './wager-transaction-kind.js';
import { WagerTransactionStatus } from './wager-transaction-status.js';
import {
  InvalidTransactionStateError,
  MissingReferenceError,
  ReservedProviderIdError,
  SelfReferenceError,
  UnexpectedReferenceError,
  UnsupportedTransactionKindError,
} from './wagering-errors.js';

/** Tentativas de resolver uma referência ausente antes de rejeitar (seção 7.1). */
export const MAX_REFERENCE_ATTEMPTS = 10;
export const REFERENCE_RETRY_BASE_DELAY_MS = 1_000;
export const REFERENCE_RETRY_MAX_DELAY_MS = 5 * 60 * 1_000;

/** Identificadores fixos da transação interna OPENING, que não vem de um provedor. */
export const INTERNAL_PROVIDER_ID = 'internal';
const OPENING_GAME_ID = 'internal';

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Kinds que cada kind pode referenciar (regra 3). BET e OPENING não têm referência. */
const ALLOWED_REFERENCE_KINDS: Partial<
  Record<WagerTransactionKind, readonly WagerTransactionKind[]>
> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

const REVERSAL_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id no provedor, não o id interno. */
  referenceExternalTransactionId: string | undefined;
  createdAt: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  /** Saldo inicial da wallet. */
  money: Money;
  at: Date;
}

/** Campos persistidos da WagerTransaction. */
export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId: string | undefined;
  failureCode: FailureCode | undefined;
  processedAt: Date | undefined;
  resultingBalance: Money | undefined;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | undefined;
}

/**
 * Operação de aposta recebida de um provedor.
 *
 * Transições válidas (PROCESSED, REJECTED e FAILED são terminais):
 *
 *   PENDING ─────────┬─► PROCESSED
 *                    ├─► REJECTED
 *                    ├─► FAILED
 *                    └─► PENDING_REFERENCE ─┬─► PROCESSED
 *                          │      ▲         ├─► REJECTED
 *                          └──────┘         └─► FAILED
 *                     (nova tentativa)
 *
 * O domínio decide se algo é válido; o caso de uso busca os dados; o banco
 * garante que a decisão vale mesmo com concorrência (por exemplo, a "única
 * reversão" por referência fica num índice único).
 */
export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
  private readonly _createdAt: Date;
  private _status: WagerTransactionStatus;
  private _referenceTransactionId: string | undefined;
  private _failureCode: FailureCode | undefined;
  private _processedAt: Date | undefined;
  private _resultingBalance: Money | undefined;
  private _referenceAttempts: number;
  private _nextReferenceAttemptAt: Date | undefined;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this._createdAt = copyDate(state.createdAt);
    this._status = state.status;
    this._referenceTransactionId = state.referenceTransactionId;
    this._failureCode = state.failureCode;
    this._processedAt = state.processedAt && copyDate(state.processedAt);
    this._resultingBalance = state.resultingBalance;
    this._referenceAttempts = state.referenceAttempts;
    this._nextReferenceAttemptAt =
      state.nextReferenceAttemptAt && copyDate(state.nextReferenceAttemptAt);
  }

  /** Operação vinda de um provedor. Nasce PENDING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    const { kind, money, referenceExternalTransactionId } = props;

    if (kind === WagerTransactionKind.Opening) {
      throw new UnsupportedTransactionKindError('OPENING é interno e não pode ser submetido');
    }

    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new ReservedProviderIdError(`O providerId "${INTERNAL_PROVIDER_ID}" é reservado`);
    }

    // LOSS aceita 0.00: provedores costumam mandar o prêmio, que numa derrota é zero.
    const amountAllowed =
      kind === WagerTransactionKind.Loss ? !money.isNegative() : money.isPositive();
    if (!amountAllowed) {
      throw new InvalidAmountError(`Valor não permitido para ${kind}: ${money.toString()}`);
    }

    if (referenceExternalTransactionId === undefined) {
      if (REVERSAL_KINDS.has(kind)) {
        throw new MissingReferenceError(`${kind} exige uma transação de referência`);
      }
    } else {
      if (ALLOWED_REFERENCE_KINDS[kind] === undefined) {
        throw new UnexpectedReferenceError(`${kind} não aceita transação de referência`);
      }
      if (referenceExternalTransactionId === props.externalTransactionId) {
        throw new SelfReferenceError('A transação não pode referenciar a si mesma');
      }
    }

    return new WagerTransaction({
      ...props,
      status: WagerTransactionStatus.Pending,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: undefined,
      resultingBalance: undefined,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
    });
  }

  /**
   * Transação interna de abertura da wallet. Nasce PROCESSED, com o saldo
   * inicial como saldo resultante. Não passa pelo create, que rejeita OPENING.
   */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    const openingKey = `opening:${props.walletId}`;

    return new WagerTransaction({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: openingKey,
      idempotencyKey: openingKey,
      payloadHash: '',
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: openingKey,
      gameId: OPENING_GAME_ID,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      referenceExternalTransactionId: undefined,
      createdAt: props.at,
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: undefined,
      failureCode: undefined,
      processedAt: props.at,
      resultingBalance: props.money,
      referenceAttempts: 0,
      nextReferenceAttemptAt: undefined,
    });
  }

  /** Reconstrói a partir do banco, sem validar. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get createdAt(): Date {
    return copyDate(this._createdAt);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  /** Id interno da referência, resolvido no processamento. */
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt && copyDate(this._processedAt);
  }

  /** Saldo observado ao finalizar a transação; devolvido no replay idempotente (regra 7). */
  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt && copyDate(this._nextReferenceAttemptAt);
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    resultingBalance: Money,
    at: Date,
  ): void {
    this.assertNotTerminal('markProcessed');

    if (this.referenceExternalTransactionId !== undefined && referenceTransactionId === undefined) {
      throw new MissingReferenceError('A referência informada não foi resolvida');
    }
    if (this.referenceExternalTransactionId === undefined && referenceTransactionId !== undefined) {
      throw new UnexpectedReferenceError(
        `${this.kind} sem referência não aceita referenceTransactionId`,
      );
    }

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultingBalance = resultingBalance;
    this._processedAt = copyDate(at);
  }

  /**
   * Registra uma tentativa sem encontrar a referência e agenda a próxima com
   * backoff exponencial: 1s, 2s, 4s, ... até o teto de 5 minutos.
   */
  markPendingReference(now: Date): void {
    this.assertNotTerminal('markPendingReference');

    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts += 1;

    const delayMs = Math.min(
      REFERENCE_RETRY_BASE_DELAY_MS * 2 ** (this._referenceAttempts - 1),
      REFERENCE_RETRY_MAX_DELAY_MS,
    );
    this._nextReferenceAttemptAt = new Date(now.getTime() + delayMs);
  }

  reject(code: FailureCode, resultingBalance: Money, at: Date): void {
    this.assertNotTerminal('reject');

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultingBalance = resultingBalance;
    this._processedAt = copyDate(at);
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');

    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = copyDate(at);
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** LOSS não altera saldo nem gera lançamento. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSAL_KINDS.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Direção do lançamento. ROLLBACK é o inverso da direção da referência. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new UnsupportedTransactionKindError('LOSS não gera lançamento no ledger');
      case WagerTransactionKind.Rollback: {
        if (reference === undefined) {
          throw new MissingReferenceError('ROLLBACK exige a referência para definir a direção');
        }
        if (!this.isAllowedReferenceKind(reference.kind)) {
          throw new UnsupportedTransactionKindError(
            `ROLLBACK de ${reference.kind} não é suportado`,
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  /**
   * Aplica as regras 2, 3 e 5 e exige a referência PROCESSED. Retorna o código
   * da rejeição, ou undefined se a referência é compatível. Uma referência
   * incompatível é um resultado de negócio esperado, não uma exceção.
   *
   * Erros de payload (kind, campos, valor) são checados antes do estado da
   * referência. A "única reversão" não é checada aqui: fica no índice único.
   *
   * Uma referência ainda PENDING ou PENDING_REFERENCE deve ser tratada como
   * ausente pelo caso de uso; recebê-la aqui é erro de programação.
   */
  checkReference(reference: WagerTransaction): FailureCode | undefined {
    if (reference.externalTransactionId !== this.referenceExternalTransactionId) {
      throw new UnexpectedReferenceError(
        `A transação ${reference.externalTransactionId} não é a referência desta operação`,
      );
    }
    if (!reference.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Referência em ${reference.status} deve ser tratada como ausente`,
      );
    }

    if (!this.isAllowedReferenceKind(reference.kind)) {
      return FailureCode.ReferenceInvalidKind;
    }

    const sameContext =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.money.currency === this.money.currency &&
      reference.roundId === this.roundId;
    if (!sameContext) {
      return FailureCode.ReferenceMismatch;
    }

    if (REVERSAL_KINDS.has(this.kind) && !reference.money.equals(this.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }

    return undefined;
  }

  isDueForReferenceRetry(now: Date): boolean {
    return (
      this._status === WagerTransactionStatus.PendingReference &&
      this._nextReferenceAttemptAt !== undefined &&
      now.getTime() >= this._nextReferenceAttemptAt.getTime()
    );
  }

  hasExhaustedReferenceAttempts(): boolean {
    return this._referenceAttempts >= MAX_REFERENCE_ATTEMPTS;
  }

  private isAllowedReferenceKind(referenceKind: WagerTransactionKind): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind]?.includes(referenceKind) ?? false;
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Transição ${transition} inválida a partir do estado terminal ${this._status}`,
      );
    }
  }
}
