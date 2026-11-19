import type { Clock } from '../../application/ports/clock.js';

/** Único ponto do projeto que lê o relógio do sistema. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
