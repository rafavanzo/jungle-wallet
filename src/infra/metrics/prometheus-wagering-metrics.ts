import { Counter, Gauge, Histogram, Registry } from 'prom-client';

import type { WageringMetrics } from '../../application/metrics/wagering-metrics.js';

/** Idade, em segundos, da mensagem pendente mais antiga da outbox (0 se não há). */
export type OutboxLagReader = () => Promise<number>;

/**
 * Métricas da seção 12 em formato Prometheus. Registry próprio por instância:
 * vários apps no mesmo processo (testes) não colidem no registro global.
 */
export class PrometheusWageringMetrics implements WageringMetrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações finalizadas por status e kind',
    labelNames: ['status', 'kind'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wager_duplicates_detected_total',
    help: 'Duplicatas detectadas (replay idempotente ou conflito)',
    labelNames: ['kind'],
    registers: [this.registry],
  });
  private readonly lockTimeouts = new Counter({
    name: 'wallet_lock_timeouts_total',
    help: 'Esperas pelo lock da wallet que estouraram o lock_timeout',
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Latência de processamento de uma transação',
    labelNames: ['kind'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'wallet_reconciliation_divergences_total',
    help: 'Reconciliações em que o saldo gravado diverge do ledger',
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'sqs_consumer_retries_total',
    help: 'Mensagens devolvidas à fila para nova tentativa',
    registers: [this.registry],
  });
  private readonly deadLettered = new Counter({
    name: 'sqs_consumer_dead_lettered_total',
    help: 'Mensagens enviadas para a DLQ, por motivo',
    labelNames: ['failure_code'],
    registers: [this.registry],
  });

  constructor(outboxLag: OutboxLagReader) {
    new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Idade da mensagem pendente mais antiga da outbox',
      registers: [this.registry],
      // Calculado no scrape: sempre o valor atual, sem job separado.
      async collect() {
        this.set(await outboxLag());
      },
    });
  }

  transactionFinished(status: string, kind: string, latencyMs: number): void {
    this.transactions.inc({ status, kind });
    this.latency.observe({ kind }, latencyMs / 1_000);
  }

  duplicateDetected(kind: 'idempotent_replay' | 'idempotency_conflict'): void {
    this.duplicates.inc({ kind });
  }

  lockTimeout(): void {
    this.lockTimeouts.inc();
  }

  reconciliationDivergence(): void {
    this.divergences.inc();
  }

  consumerRetry(): void {
    this.retries.inc();
  }

  consumerDeadLettered(failureCode: string): void {
    this.deadLettered.inc({ failure_code: failureCode });
  }
}
