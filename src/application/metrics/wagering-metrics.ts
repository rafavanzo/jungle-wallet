/**
 * Momentos de negócio que alimentam as métricas operacionais (seção 12).
 * Quem os conhece é o caso de uso; a implementação (Prometheus) fica na infra.
 */
export interface WageringMetrics {
  transactionFinished(status: string, kind: string, latencyMs: number): void;
  duplicateDetected(kind: 'idempotent_replay' | 'idempotency_conflict'): void;
  lockTimeout(): void;
}

export const WAGERING_METRICS = Symbol('WageringMetrics');

/** Implementação vazia, até a Etapa 8. */
export class NoopWageringMetrics implements WageringMetrics {
  transactionFinished(): void {}
  duplicateDetected(): void {}
  lockTimeout(): void {}
}
