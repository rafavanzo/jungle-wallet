import { StandardSchemaValidationPipe } from '@nestjs/common';

import { HttpRequestError } from './http-errors.js';

/** Forma mínima de uma issue do Standard Schema. */
interface Issue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/**
 * Validação global pelos schemas Zod declarados em @Body/@Param/@Query. O pipe
 * não converte tipos por conta própria: só um `z.coerce` converteria, e nenhum
 * schema usa. Falhas viram VALIDATION_ERROR (400).
 */
export function createValidationPipe(): StandardSchemaValidationPipe {
  return new StandardSchemaValidationPipe({
    exceptionFactory: (issues) =>
      new HttpRequestError('VALIDATION_ERROR', issues.map(formatIssue).join('; ')),
  });
}

function formatIssue(issue: Issue): string {
  const path = (issue.path ?? [])
    .map((segment) => (typeof segment === 'object' ? segment.key : segment))
    .map(String)
    .join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}
