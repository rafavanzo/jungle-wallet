import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import type { MikroORM as PostgreSqlMikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';

export const HEALTH_SQS_CLIENT = Symbol('HEALTH_SQS_CLIENT');
export const HEALTH_SQS_QUEUE_NAME = Symbol('HEALTH_SQS_QUEUE_NAME');
const CHECK_TIMEOUT_MS = 1_000;

type DependencyStatus = 'up' | 'down';

/**
 * Health checks, sem autenticação. O correlation id vem do
 * middleware global.
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(MikroORM) private readonly orm: PostgreSqlMikroORM,
    @Inject(HEALTH_SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(HEALTH_SQS_QUEUE_NAME) private readonly queueName: string,
  ) {}

  /** O processo está vivo: não depende de banco nem de fila. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Pronto para receber tráfego: Postgres e SQS respondem em até 1 s cada. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const [postgres, sqs] = await Promise.all([
      check(() => this.orm.em.getConnection().execute('SELECT 1')),
      check((signal) =>
        this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }), {
          abortSignal: signal,
        }),
      ),
    ]);
    const ready = postgres === 'up' && sqs === 'up';
    response.status(ready ? 200 : 503);
    return { status: ready ? 'ok' : 'unavailable', checks: { postgres, sqs } };
  }
}

async function check(probe: (signal: AbortSignal) => Promise<unknown>): Promise<DependencyStatus> {
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const timeout = new Promise<never>((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error('timeout'))),
  );
  try {
    await Promise.race([probe(signal), timeout]);
    return 'up';
  } catch {
    return 'down';
  }
}
