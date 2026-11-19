import { describe, expect, it } from 'bun:test';

import { InvalidCursorError } from '../errors/application-errors.js';
import { decodeLedgerCursor, encodeLedgerCursor } from './ledger-cursor.js';

const ENTRY_ID = '0192f298-345e-7e38-af88-e43f851a819d';

describe('cursor do ledger', () => {
  it('ida e volta devolve o mesmo afterId', () => {
    expect(decodeLedgerCursor(encodeLedgerCursor(ENTRY_ID))).toBe(ENTRY_ID);
  });

  it('é opaco e seguro para URL (base64url, sem + / =)', () => {
    expect(encodeLedgerCursor(ENTRY_ID)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['lixo', 'não-é-base64'],
    ['JSON sem versão', Buffer.from(JSON.stringify({ afterId: ENTRY_ID })).toString('base64url')],
    [
      'versão desconhecida',
      Buffer.from(JSON.stringify({ v: 2, afterId: ENTRY_ID })).toString('base64url'),
    ],
    [
      'afterId que não é UUID',
      Buffer.from(JSON.stringify({ v: 1, afterId: 'x' })).toString('base64url'),
    ],
  ])('%s lança INVALID_CURSOR', (_case, cursor) => {
    expect(() => decodeLedgerCursor(cursor)).toThrow(InvalidCursorError);
  });
});
