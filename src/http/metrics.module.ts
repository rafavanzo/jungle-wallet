import { MikroORM } from '@mikro-orm/core';
import type { MikroORM as PostgreSqlMikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Global, Header, Inject, Module } from '@nestjs/common';

import { WAGERING_METRICS } from '../application/metrics/wagering-metrics.js';
import { PrometheusWageringMetrics } from '../infra/metrics/prometheus-wagering-metrics.js';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(WAGERING_METRICS) private readonly metrics: PrometheusWageringMetrics) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}

/** Uma instância de métricas para o processo inteiro: API, consumidor e workers. */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: WAGERING_METRICS,
      useFactory: (orm: PostgreSqlMikroORM) =>
        new PrometheusWageringMetrics(async () => {
          try {
            const [row] = await orm.em.getConnection().execute<{ lag: number | null }[]>(
              `SELECT EXTRACT(EPOCH FROM now() - MIN(occurred_at))::float8 AS lag
                   FROM outbox_messages WHERE published_at IS NULL`,
            );
            return Math.max(0, row?.lag ?? 0);
          } catch {
            // Banco fora do ar: o scrape continua respondendo, sem valor.
            return Number.NaN;
          }
        }),
      inject: [MikroORM],
    },
  ],
  exports: [WAGERING_METRICS],
})
export class MetricsModule {}
