export function escapeCsvCell(value: unknown): string {
  let text = String(value ?? '');
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
  if (/[\r\n,"]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
