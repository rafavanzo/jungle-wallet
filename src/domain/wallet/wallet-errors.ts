import { DomainError } from '../shared/domain-error.js';

export class InsufficientFundsError extends DomainError {
  override readonly code = 'INSUFFICIENT_FUNDS';
}

/** A conta do lançamento não fecha: balanceBefore ± money ≠ balanceAfter. */
export class UnbalancedLedgerEntryError extends DomainError {
  override readonly code = 'UNBALANCED_LEDGER_ENTRY';
}
