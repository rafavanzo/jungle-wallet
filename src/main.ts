import { parseAppRoles } from './app-roles.js';
import { createHttpApp } from './http/create-http-app.js';
import { OutboxPublisherWorker } from './workers/outbox-publisher.worker.js';

async function bootstrap() {
  const roles = parseAppRoles(process.env.APP_ROLES);
  const app = await createHttpApp();

  if (roles.has('api')) {
    await app.listen(process.env.PORT ?? 3000);
  } else {
    // Só workers: inicializa os módulos (e os hooks de shutdown) sem abrir a porta HTTP.
    await app.init();
  }

  if (roles.has('outbox')) {
    app.get(OutboxPublisherWorker).start();
  }
  // "consumer" e "pending" ainda não têm worker.
}
await bootstrap();
