/**
 * Converte um texto do banco para um valor de enum, falhando alto se ele não
 * existir. Nenhum valor chega ao domínio sem validação.
 */
export function parseEnum<E extends Record<string, string>>(
  enumObject: E,
  value: string,
  field: string,
): E[keyof E] {
  const values = Object.values(enumObject) as string[];
  if (!values.includes(value)) {
    throw new Error(`Valor inválido para ${field} vindo do banco: "${value}"`);
  }
  return value as E[keyof E];
}
