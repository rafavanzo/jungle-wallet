import { createHttpApp } from './http/create-http-app.js';

async function bootstrap() {
  const app = await createHttpApp();
  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
