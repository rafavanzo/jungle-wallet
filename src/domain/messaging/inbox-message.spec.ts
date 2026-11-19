import { describe, expect, it } from 'bun:test';

import { InboxMessage } from './inbox-message.js';
import { InvalidMessageStateError } from './messaging-errors.js';

const RECEIVED_AT = new Date('2026-11-19T10:00:00.000Z');
const PROCESSED_AT = new Date('2026-11-19T10:00:01.000Z');

const receive = (): InboxMessage =>
  InboxMessage.receive({
    messageId: 'msg-1',
    consumerName: 'wager-consumer',
    payloadHash: 'sha256-v1:abc',
    receivedAt: RECEIVED_AT,
  });

describe('InboxMessage', () => {
  it('receive cria a mensagem ainda não processada', () => {
    const message = receive();

    expect(message.messageId).toBe('msg-1');
    expect(message.consumerName).toBe('wager-consumer');
    expect(message.payloadHash).toBe('sha256-v1:abc');
    expect(message.receivedAt).toEqual(RECEIVED_AT);
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  it('markProcessed registra o horário; processar de novo lança erro', () => {
    const message = receive();

    message.markProcessed(PROCESSED_AT);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(PROCESSED_AT);
    expect(() => message.markProcessed(PROCESSED_AT)).toThrow(InvalidMessageStateError);
  });
});
