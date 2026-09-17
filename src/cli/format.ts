/**
 * Output formatting for the CLI.
 *
 * Every command prints JSON to stdout by default (machine-readable). With
 * `--format human` the same payload is rendered as a short summary table.
 */

export type Format = 'json' | 'human';

export function print(result: unknown, format: Format): void {
  if (format === 'human') {
    process.stdout.write(toHuman(result));
    process.stdout.write('\n');
  } else {
    process.stdout.write(JSON.stringify(result, null, 2));
    process.stdout.write('\n');
  }
}

export function error(message: string, format: Format): void {
  if (format === 'human') {
    process.stderr.write(`Error: ${message}\n`);
  } else {
    process.stderr.write(JSON.stringify({ error: message }) + '\n');
  }
}

function toHuman(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (Array.isArray(result)) {
    return renderArray(result);
  }
  if (typeof result === 'object') {
    return renderObject(result as Record<string, unknown>);
  }
  return String(result);
}

function renderArray(items: unknown[]): string {
  if (items.length === 0) return '(none)';
  const lines: string[] = [];
  for (const item of items) {
    if (item && typeof item === 'object') {
      lines.push(renderObject(item as Record<string, unknown>));
    } else {
      lines.push(String(item));
    }
  }
  return lines.join('\n\n');
}

function renderObject(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    const rendered = renderValue(value);
    if (rendered === null) continue;
    lines.push(`  ${key}: ${rendered}`);
  }
  return lines.join('\n');
}

function renderValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function money(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const euros = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}${euros}.${String(cents).padStart(2, '0')}`;
}
