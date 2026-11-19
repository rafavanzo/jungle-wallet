export interface IdGenerator {
  /** Novo identificador único, ordenável por tempo (UUID v7). */
  next(): string;
}

export const ID_GENERATOR = Symbol('IdGenerator');
