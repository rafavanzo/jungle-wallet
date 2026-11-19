import { type BeforeApplicationShutdown, Logger } from '@nestjs/common';

import {
  OUTBOX_BATCH_SIZE,
  type PublishOutboxBatchUseCase,
} from '../application/outbox/publish-outbox-batch.use-case.js';

export const OUTBOX_IDLE_DELAY_MS = 500;

/**
 * Loop do publisher: lote cheio roda de novo na hora (há mais pendências);
 * lote incompleto ou erro espera 500 ms. No shutdown para de buscar e termina
 * o lote em andamento antes de o ORM fechar.
 */
export class OutboxPublisherWorker implements BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly publishBatch: Pick<PublishOutboxBatchUseCase, 'execute'>,
    private readonly batchSize: number = OUTBOX_BATCH_SIZE,
    private readonly idleDelayMs: number = OUTBOX_IDLE_DELAY_MS,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.runLoop();
    this.logger.log('Publisher da outbox iniciado');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  // Antes do onApplicationShutdown, em que o módulo do MikroORM fecha as conexões.
  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        const result = await this.publishBatch.execute();
        claimed = result.claimed;
        if (result.failed > 0) {
          this.logger.warn(`${result.failed} de ${result.claimed} eventos reagendados`);
        }
      } catch (error) {
        // Banco fora do ar, por exemplo: as travas caem com a transação e o lote volta.
        this.logger.error('Ciclo do publisher da outbox falhou', error);
      }
      if (this.running && claimed < this.batchSize) {
        await this.sleep(this.idleDelayMs);
      }
    }
  }

  /** Espera interrompível pelo stop(). */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
