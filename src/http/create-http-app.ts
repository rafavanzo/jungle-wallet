import { ConsoleLogger, type NestApplicationOptions } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { ID_GENERATOR, type IdGenerator } from '../application/ports/id-generator.js';
import { AppModule } from '../app.module.js';
import { correlationIdMiddleware } from './correlation-id.js';

const JSON_BODY_LIMIT = '100kb';

/**
 * Monta a aplicação HTTP. Usado pelo main.ts e pelos testes e2e, para que os
 * dois rodem exatamente a mesma configuração.
 *
 * O parser de JSON do Nest é desligado e registrado depois do middleware de
 * correlação: a ordem dos `app.use` é a ordem de execução.
 */
export async function createHttpApp(
  options: NestApplicationOptions = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Logs em JSON, uma linha por evento (seção 12). Os testes passam logger: false.
    logger: new ConsoleLogger({ json: true }),
    ...options,
    bodyParser: false,
  });

  app.use(correlationIdMiddleware(app.get<IdGenerator>(ID_GENERATOR)));
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  // Fecha conexões e consumidores no SIGTERM (usado pelo consumidor SQS).
  app.enableShutdownHooks();

  return app;
}
