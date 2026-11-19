export const APP_ROLES = ['api', 'outbox', 'consumer', 'pending'] as const;

export type AppRole = (typeof APP_ROLES)[number];

/**
 * APP_ROLES=api,outbox,consumer,pending escolhe o que este processo liga.
 * Vazio ou ausente liga todos. Papel desconhecido é erro, para um erro de
 * digitação não desligar um worker em silêncio.
 */
export function parseAppRoles(raw: string | undefined): ReadonlySet<AppRole> {
  if (raw === undefined || raw.trim() === '') {
    return new Set(APP_ROLES);
  }
  const roles = new Set<AppRole>();
  for (const part of raw.split(',')) {
    const role = part.trim();
    if (role === '') {
      continue;
    }
    if (!isAppRole(role)) {
      throw new Error(
        `APP_ROLES com papel desconhecido: "${role}" (válidos: ${APP_ROLES.join(', ')})`,
      );
    }
    roles.add(role);
  }
  if (roles.size === 0) {
    throw new Error('APP_ROLES não liga nenhum papel');
  }
  return roles;
}

function isAppRole(value: string): value is AppRole {
  return (APP_ROLES as readonly string[]).includes(value);
}
