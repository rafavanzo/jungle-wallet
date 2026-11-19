import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

import { ApplicationError } from '../application/errors/application-errors.js';
import { TransientInfrastructureError } from '../application/ports/persistence-errors.js';
import { DomainError } from '../domain/shared/domain-error.js';
import type { RequestWithCorrelationId } from './correlation-id.js';
import { ERROR_STATUS, type ErrorCode } from './error-status-map.js';
import { HttpRequestError } from './http-errors.js';

const RETRY_AFTER_SECONDS = '1';
const INTERNAL_MESSAGE = 'Erro interno';

interface ErrorDescription {
  code: ErrorCode;
  message: string;
}

/**
 * Único tradutor de erro para resposta HTTP. Corpo sempre no formato
 * `{ error: { code, message }, correlationId }`. Um 500 nunca expõe detalhes
 * internos: stack, SQL e mensagem original vão só para o log.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithCorrelationId>();
    const response = context.getResponse<Response>();

    const described = describe(exception);
    const status = ERROR_STATUS[described.code];
    const message = status === 500 ? INTERNAL_MESSAGE : described.message;

    if (status === 500) {
      this.logger.error(
        `${described.code} em ${request.method} ${request.url} (correlationId=${request.correlationId})`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (status === 503) {
      this.logger.warn(
        `Falha transitória em ${request.method} ${request.url}: ${described.message}`,
      );
      response.setHeader('Retry-After', RETRY_AFTER_SECONDS);
    }

    response.status(status).json({
      error: { code: described.code, message },
      correlationId: request.correlationId ?? null,
    });
  }
}

function describe(exception: unknown): ErrorDescription {
  if (
    exception instanceof DomainError ||
    exception instanceof ApplicationError ||
    exception instanceof HttpRequestError
  ) {
    return { code: exception.code, message: exception.message };
  }
  if (exception instanceof TransientInfrastructureError) {
    return {
      code: 'TRANSIENT_INFRASTRUCTURE',
      message: 'Falha temporária de infraestrutura; reenvie com a mesma Idempotency-Key',
    };
  }
  // Erros do próprio Nest/Express: JSON malformado, rota inexistente, corpo grande.
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status === 404) return { code: 'ROUTE_NOT_FOUND', message: 'Rota não encontrada' };
    if (status === 413)
      return { code: 'PAYLOAD_TOO_LARGE', message: 'Corpo da requisição grande demais' };
    if (status >= 400 && status < 500) {
      return { code: 'VALIDATION_ERROR', message: 'Requisição inválida (JSON malformado?)' };
    }
  }
  return { code: 'INTERNAL_ERROR', message: INTERNAL_MESSAGE };
}
