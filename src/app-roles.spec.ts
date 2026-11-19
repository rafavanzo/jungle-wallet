import { describe, expect, it } from 'bun:test';

import { APP_ROLES, parseAppRoles } from './app-roles.js';

describe('parseAppRoles', () => {
  it('ausente ou vazio liga todos os papéis', () => {
    expect([...parseAppRoles(undefined)]).toEqual([...APP_ROLES]);
    expect([...parseAppRoles('  ')]).toEqual([...APP_ROLES]);
  });

  it('liga só os papéis listados, ignorando espaços', () => {
    expect([...parseAppRoles(' api , outbox ')]).toEqual(['api', 'outbox']);
  });

  it('papel desconhecido é erro', () => {
    expect(() => parseAppRoles('api,outbx')).toThrow('outbx');
  });

  it('lista sem nenhum papel é erro', () => {
    expect(() => parseAppRoles(',,')).toThrow('nenhum papel');
  });
});
