import type { MoneyProps } from '../../domain/shared/money.js';
import { WalletNotFoundError } from '../errors/application-errors.js';
import type { WageringMetrics } from '../metrics/wagering-metrics.js';
import type { ReconciliationReader } from '../ports/reconciliation-reader.js';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** stored − calculated. */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Confere o saldo gravado contra o ledger. Uma divergência NUNCA é corrigida
 * aqui: é sinalizada (métrica e resposta) para investigação.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly reader: ReconciliationReader,
    private readonly metrics: WageringMetrics,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const snapshot = await this.reader.read(walletId);
    if (!snapshot) {
      throw new WalletNotFoundError(`Wallet ${walletId} não encontrada`);
    }
    const money = (amount: string): MoneyProps => ({ amount, currency: snapshot.currency });
    const consistent = snapshot.storedBalance === snapshot.calculatedBalance;
    if (!consistent) {
      this.metrics.reconciliationDivergence();
    }
    return {
      walletId,
      storedBalance: money(snapshot.storedBalance),
      calculatedBalance: money(snapshot.calculatedBalance),
      difference: money(snapshot.difference),
      consistent,
      checkedEntries: snapshot.checkedEntries,
    };
  }
}
