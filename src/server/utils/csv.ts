/**
 * CSV escaping conforme RFC 4180:
 *  - se contém aspas, vírgula ou newline → envolve em aspas
 *  - aspas internas são duplicadas
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function csvRow(cells: unknown[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}
