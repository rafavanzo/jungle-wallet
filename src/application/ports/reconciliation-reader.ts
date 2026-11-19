/** Saldo gravado e saldo recalculado pelo ledger, lidos do mesmo snapshot. */
export interface ReconciliationSnapshot {
  currency: string;
  /** Decimais em texto, direto do NUMERIC: sem passar por número. */
  storedBalance: string;
  calculatedBalance: string;
  difference: string;
  checkedEntries: number;
}

export interface ReconciliationReader {
  /** `undefined` se a wallet não existe. Nunca escreve nada. */
  read(walletId: string): Promise<ReconciliationSnapshot | undefined>;
}

export const RECONCILIATION_READER = Symbol('ReconciliationReader');
