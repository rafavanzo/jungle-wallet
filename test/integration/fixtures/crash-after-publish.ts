/**
 * Processo do publisher que "morre" no pior momento: publica a primeira
 * mensagem do lote no SQS, avisa no stdout e trava antes do commit. O teste
 * mata o processo; a conexão cai e o Postgres desfaz a transação.
 *
 * Uso: DATABASE_URL=<banco> bun test/integration/fixtures/crash-after-publish.ts
 */
import { MikroORM } from '@mikro-orm/postgresql';

import { PublishOutboxBatchUseCase } from '../../../src/application/outbox/publish-outbox-batch.use-case.js';
import type { EventPublisher } from '../../../src/application/ports/event-publisher.js';
import {
  buildOrmConfig,
  requireDatabaseUrl,
} from '../../../src/infra/database/mikro-orm.config.js';
import { MikroOrmUnitOfWork } from '../../../src/infra/database/mikro-orm-unit-of-work.js';
import {
  createSqsClient,
  readSqsSettings,
  SqsEventPublisher,
} from '../../../src/infra/messaging/sqs-event-publisher.js';
import { SystemClock } from '../../../src/infra/system/system-clock.js';

const orm = await MikroORM.init(buildOrmConfig(requireDatabaseUrl()));
const sqs = new SqsEventPublisher(
  createSqsClient(readSqsSettings()),
  process.env.SQS_EVENTS_QUEUE_NAME ?? '',
);

const publishThenHang: EventPublisher = {
  async publish(event) {
    await sqs.publish(event);
    console.log(`PUBLISHED ${event.eventId}`);
    // Mantém o processo vivo, com a transação aberta, até ser morto.
    setInterval(() => undefined, 60_000);
    await new Promise<never>(() => undefined);
  },
};

await new PublishOutboxBatchUseCase(
  new MikroOrmUnitOfWork(orm),
  publishThenHang,
  new SystemClock(),
).execute();
