/**
 * Cópia defensiva de um Date. `Object.freeze` e `readonly` não impedem
 * `date.setFullYear(...)`, então entidades copiam a data ao receber e ao expor.
 */
export function copyDate(date: Date): Date {
  return new Date(date.getTime());
}
