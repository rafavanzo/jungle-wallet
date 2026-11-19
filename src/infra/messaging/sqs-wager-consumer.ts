import { createHash } from 'node:crypto';

import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { type BeforeApplicationShutdown, Logger } from '@nestjs/common';

import {
  ApplicationError,
  DuplicateMessageError,
} from '../../application/errors/application-errors.js';
import {
  NoopWageringMetrics,
  type WageringMetrics,
} from '../../application/metrics/wagering-metrics.js';
import { TransientInfrastructureError } from '../../application/ports/persistence-errors.js';
import type { SubmitWagerTransactionUseCase } from '../../application/wagering/submit-wager-transaction.use-case.js';
import { wagerTransactionRequestedSchema } from '../../contracts/wager-message.contract.js';
import { DomainError } from '../../domain/shared/domain-error.js';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';
const MAX_RETRY_DELAY_SECONDS = 60;
const MAX_REASON_LENGTH = 256;

export interface WagerConsumerSettings {
  queueName: string;
  dlqName: string;
  /** Recebimentos permitidos antes de mandar para a DLQ. */
  maxReceiveCount: number;
  waitTimeSeconds: number;
  /** Espera máxima pela mensagem em andamento no shutdown. */
  shutdownGraceMs: number;
}

export type ConsumerAction =
  | { kind: 'ack'; transactionId: string; status: string }
  | { kind: 'retry'; delaySeconds: number; reason: string }
  | { kind: 'dlq'; failureCode: string; reason: string };

/**
 * Consome wager-transactions.fifo e chama o MESMO caso de uso do HTTP.
 *
 * - ack (DeleteMessage) só depois do commit: o caso de uso já retornou;
 * - resultado de negócio (PROCESSED, REJECTED, PENDING_REFERENCE) → ack;
 * - erro transitório ou desconhecido → sem ack, visibilidade com backoff,
 *   até o limite de recebimentos; depois DLQ;
 * - erro permanente (payload inválido, wallet inexistente, conflito de
 *   idempotência, validação de domínio) → DLQ na hora.
 *
 * Mensagens de um lote são processadas em sequência (ordem FIFO). Redelivery é
 * seguro: a inbox, na mesma transação, deduplica pela messageId.
 */
export class SqsWagerConsumer implements BeforeApplicationShutdown {
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private running = false;
  private loop: Promise<void> | undefined;
  private abort = new AbortController();
  private inFlight: Message | undefined;
  private urls: Promise<{ queue: string; dlq: string }> | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly settings: WagerConsumerSettings,
    private readonly metrics: WageringMetrics = new NoopWageringMetrics(),
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.runLoop();
    this.logger.log({ msg: 'Consumidor SQS iniciado', queue: this.settings.queueName });
  }

  /**
   * Para de buscar (aborta o long poll), espera a mensagem em andamento até o
   * limite e devolve a visibilidade do que não terminou.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.abort.abort();
    const finished = await Promise.race([
      this.loop?.then(() => true),
      Bun.sleep(this.settings.shutdownGraceMs).then(() => false),
    ]);
    if (!finished && this.inFlight) {
      await this.release([this.inFlight]);
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Valida, chama o caso de uso e decide a ação. Não fala com o SQS. */
  async process(message: Message): Promise<ConsumerAction> {
    const body = message.Body ?? '';
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');

    let envelope: unknown;
    try {
      envelope = JSON.parse(body);
    } catch {
      return { kind: 'dlq', failureCode: 'INVALID_PAYLOAD', reason: 'Corpo não é JSON' };
    }
    const parsed = wagerTransactionRequestedSchema.safeParse(envelope);
    if (!parsed.success) {
      const reason = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      return { kind: 'dlq', failureCode: 'INVALID_PAYLOAD', reason };
    }

    const { messageId, data } = parsed.data;
    try {
      const result = await this.submit.execute({
        ...data,
        correlationId: messageId,
        causationId: messageId,
        inbox: {
          consumerName: WAGER_CONSUMER_NAME,
          messageId,
          payloadHash: createHash('sha256').update(body).digest('hex'),
        },
      });
      if (result.duplicateMessage?.payloadMismatch) {
        this.logger.warn({
          msg: 'messageId repetida com outro corpo; tratada como duplicata',
          messageId,
          transactionId: result.transactionId,
        });
      }
      return { kind: 'ack', transactionId: result.transactionId, status: result.status };
    } catch (error) {
      if (error instanceof DuplicateMessageError) {
        this.logger.warn({ msg: 'messageId repetida com outro corpo; ack', messageId });
        return { kind: 'ack', transactionId: '-', status: 'DUPLICATE_MESSAGE' };
      }
      if (error instanceof DomainError || error instanceof ApplicationError) {
        return { kind: 'dlq', failureCode: error.code, reason: error.message };
      }
      const transient = error instanceof TransientInfrastructureError;
      if (!transient) {
        this.logger.error({ msg: 'Erro inesperado no consumidor', messageId }, error);
      }
      if (receiveCount >= this.settings.maxReceiveCount) {
        return {
          kind: 'dlq',
          failureCode: transient ? 'TRANSIENT_RETRIES_EXHAUSTED' : 'PROCESSING_ERROR',
          reason: errorText(error),
        };
      }
      return {
        kind: 'retry',
        delaySeconds: Math.min(2 ** receiveCount, MAX_RETRY_DELAY_SECONDS),
        reason: errorText(error),
      };
    }
  }

  /** Executa a ação no SQS. */
  async settle(message: Message, action: ConsumerAction): Promise<void> {
    const { queue, dlq } = await this.queueUrls();
    const messageId = message.MessageId;

    if (action.kind === 'retry') {
      await this.client.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queue,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: action.delaySeconds,
        }),
      );
      this.metrics.consumerRetry();
      this.logger.warn({ msg: 'retry', sqsMessageId: messageId, ...action });
      return;
    }

    if (action.kind === 'dlq') {
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: dlq,
          MessageBody: message.Body ?? '',
          MessageGroupId: message.Attributes?.MessageGroupId ?? 'unknown',
          MessageDeduplicationId: messageId,
          MessageAttributes: {
            failureCode: { DataType: 'String', StringValue: action.failureCode },
            reason: {
              DataType: 'String',
              StringValue: action.reason.slice(0, MAX_REASON_LENGTH) || '-',
            },
          },
        }),
      );
      this.metrics.consumerDeadLettered(action.failureCode);
      this.logger.error({ msg: 'dlq', sqsMessageId: messageId, failureCode: action.failureCode });
    }

    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: queue, ReceiptHandle: message.ReceiptHandle }),
    );
    if (action.kind === 'ack') {
      this.logger.log({ msg: 'ack', sqsMessageId: messageId, ...action });
    }
  }

  private async handle(message: Message): Promise<void> {
    try {
      await this.settle(message, await this.process(message));
    } catch (error) {
      // Sem ack: a mensagem volta depois do visibility timeout.
      this.logger.error(
        { msg: 'Falha ao tratar mensagem', sqsMessageId: message.MessageId },
        error,
      );
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let messages: Message[];
      try {
        const { queue } = await this.queueUrls();
        const output = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: queue,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.settings.waitTimeSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = output.Messages ?? [];
      } catch (error) {
        if (!this.running) {
          break;
        }
        this.logger.error({ msg: 'Falha no ReceiveMessage' }, error);
        await Bun.sleep(1_000);
        continue;
      }

      for (const [index, message] of messages.entries()) {
        if (!this.running) {
          await this.release(messages.slice(index));
          break;
        }
        this.inFlight = message;
        await this.handle(message);
        this.inFlight = undefined;
      }
    }
  }

  /** Devolve à fila na hora (visibilidade 0): outra instância pega. */
  private async release(messages: readonly Message[]): Promise<void> {
    const { queue } = await this.queueUrls();
    await Promise.allSettled(
      messages.map((message) =>
        this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queue,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0,
          }),
        ),
      ),
    );
  }

  private queueUrls(): Promise<{ queue: string; dlq: string }> {
    if (!this.urls) {
      const resolve = async (name: string) => {
        const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
        if (!QueueUrl) {
          throw new Error(`Fila ${name} sem URL`);
        }
        return QueueUrl;
      };
      const pending = Promise.all([
        resolve(this.settings.queueName),
        resolve(this.settings.dlqName),
      ]).then(([queue, dlq]) => ({ queue, dlq }));
      pending.catch(() => {
        if (this.urls === pending) {
          this.urls = undefined;
        }
      });
      this.urls = pending;
    }
    return this.urls;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
