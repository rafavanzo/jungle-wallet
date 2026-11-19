import { copyDate } from '../shared/copy-date.js';
import { InvalidMessageStateError } from './messaging-errors.js';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt: Date | undefined;
}

/** Registro de uma mensagem recebida, para deduplicar por (consumerName, messageId). */
export class InboxMessage {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  private readonly _receivedAt: Date;
  private _processedAt: Date | undefined;

  private constructor(state: InboxMessageState) {
    this.messageId = state.messageId;
    this.consumerName = state.consumerName;
    this.payloadHash = state.payloadHash;
    this._receivedAt = copyDate(state.receivedAt);
    this._processedAt = state.processedAt && copyDate(state.processedAt);
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage({ ...props, processedAt: undefined });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state);
  }

  get receivedAt(): Date {
    return copyDate(this._receivedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt && copyDate(this._processedAt);
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError(`A mensagem ${this.messageId} já foi processada`);
    }
    this._processedAt = copyDate(at);
  }
}
