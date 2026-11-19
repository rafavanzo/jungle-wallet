import { createParamDecorator, type ExecutionContext, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import type { IdGenerator } from '../application/ports/id-generator.js';

export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

/** ASCII visível, até 128 caracteres. */
const VALID_CORRELATION_ID = /^[\x21-\x7E]{1,128}$/;

export interface RequestWithCorrelationId extends Request {
  correlationId?: string;
}

/**
 * Middleware do Express registrado antes do parser de JSON, então toda resposta
 * tem correlation id (inclusive a de um JSON malformado).
 *
 * Usa o X-Correlation-Id recebido, ou gera um (UUID v7). Um valor inválido é
 * substituído por um gerado, com aviso no log: um header de rastreamento não
 * impede uma aposta válida (tolerant reader, como nos campos extras).
 */
export function correlationIdMiddleware(ids: IdGenerator) {
  const logger = new Logger('CorrelationId');

  return (request: RequestWithCorrelationId, response: Response, next: NextFunction): void => {
    const incoming = request.headers[CORRELATION_ID_HEADER.toLowerCase()];
    const valid = typeof incoming === 'string' && VALID_CORRELATION_ID.test(incoming);

    request.correlationId = valid ? incoming : ids.next();
    if (incoming !== undefined && !valid) {
      logger.warn(
        `${CORRELATION_ID_HEADER} inválido substituído por ${request.correlationId} em ${request.method} ${request.url}`,
      );
    }

    response.setHeader(CORRELATION_ID_HEADER, request.correlationId);
    next();
  };
}

export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<RequestWithCorrelationId>();
    if (request.correlationId === undefined) {
      throw new Error('correlationIdMiddleware não foi registrado (ver createHttpApp)');
    }
    return request.correlationId;
  },
);
