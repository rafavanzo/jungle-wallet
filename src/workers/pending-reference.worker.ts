import { type BeforeApplicationShutdown, Logger } from '@nestjs/common';

import type { RetryPendingReferencesUseCase } from '../application/wagering/retry-pending-references.use-case.js';

export const PENDING_REFERENCE_INTERVAL_MS = 1_000;

/** Roda um ciclo de RetryPendingReferences a cada 1 s. No shutdown termina o ciclo atual. */
export class PendingReferenceWorker implements BeforeApplicationShutdown {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly retryPending: Pick<RetryPendingReferencesUseCase, 'execute'>,
    private readonly intervalMs: number = PENDING_REFERENCE_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.runLoop();
    this.logger.log('Worker de referência pendente iniciado');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const { candidates, outcomes } = await this.retryPending.execute();
        if (candidates > 0) {
          this.logger.log({ msg: 'Referências pendentes reprocessadas', candidates, outcomes });
        }
      } catch (error) {
        this.logger.error({ msg: 'Ciclo de referência pendente falhou' }, error);
      }
      if (this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.intervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }
}
