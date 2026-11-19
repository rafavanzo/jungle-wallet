import { Module } from '@nestjs/common';

import { WAGERING_METRICS, type WageringMetrics } from '../application/metrics/wagering-metrics.js';
import { CLOCK, type Clock } from '../application/ports/clock.js';
import { ID_GENERATOR, type IdGenerator } from '../application/ports/id-generator.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../application/ports/unit-of-work.js';
import { SubmitWagerTransactionUseCase } from '../application/wagering/submit-wager-transaction.use-case.js';
import { DatabaseModule } from '../infra/database/database.module.js';
import { createSqsClient, readSqsSettings } from '../infra/messaging/sqs-event-publisher.js';
import { SqsWagerConsumer } from '../infra/messaging/sqs-wager-consumer.js';

/** O long poll (10 s) precisa de um timeout de requisição maior que ele. */
const CONSUMER_REQUEST_TIMEOUT_MS = 20_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente ${name} não definida`);
  }
  return value;
}

function readMaxReceiveCount(): number {
  const value = Number(process.env.MAX_RECEIVE_COUNT ?? '5');
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`MAX_RECEIVE_COUNT inválido: ${process.env.MAX_RECEIVE_COUNT}`);
  }
  return value;
}

/** O consumidor é montado sempre, mas só o main.ts o liga (papel "consumer"). */
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: SubmitWagerTransactionUseCase,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: WageringMetrics) =>
        new SubmitWagerTransactionUseCase(uow, clock, ids, metrics),
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR, WAGERING_METRICS],
    },
    {
      provide: SqsWagerConsumer,
      useFactory: (submit: SubmitWagerTransactionUseCase, metrics: WageringMetrics) =>
        new SqsWagerConsumer(
          createSqsClient(readSqsSettings(), CONSUMER_REQUEST_TIMEOUT_MS),
          submit,
          {
            queueName: requireEnv('SQS_WAGER_QUEUE_NAME'),
            dlqName: requireEnv('SQS_WAGER_DLQ_NAME'),
            maxReceiveCount: readMaxReceiveCount(),
            waitTimeSeconds: 10,
            shutdownGraceMs: 10_000,
          },
          metrics,
        ),
      inject: [SubmitWagerTransactionUseCase, WAGERING_METRICS],
    },
  ],
  exports: [SqsWagerConsumer],
})
export class WagerConsumerModule {}
