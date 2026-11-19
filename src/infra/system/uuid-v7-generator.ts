import type { IdGenerator } from '../../application/ports/id-generator.js';

/** Único ponto do projeto que gera ids. UUID v7 é ordenável por tempo. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
