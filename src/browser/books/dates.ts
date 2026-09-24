export function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return validDate(m[1]!, m[2]!, m[3]!);
  m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(s);
  if (!m) return null;
  let day = Number(m[1]);
  let month = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  if (month > 12 && day <= 12) {
    const swap = day;
    day = month;
    month = swap;
  }
  return validDate(year, month, day);
}

function validDate(y: number | string, m: number | string, d: number | string): string | null {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function dateDiffDays(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return Number.NaN;
  return Math.round((da - db) / 86_400_000);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Irish VAT3 bi-monthly periods: Jan–Feb, Mar–Apr, … */
export function vatPeriodContaining(iso: string): { from: string; to: string; label: string } {
  const [yearStr, monthStr] = iso.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const start = month - ((month - 1) % 2);
  const from = `${year}-${String(start).padStart(2, "0")}-01`;
  const end = new Date(Date.UTC(year, start + 1, 0));
  const to = end.toISOString().slice(0, 10);
  return {
    from,
    to,
    label: `${MONTHS[start - 1]}–${MONTHS[start]} ${year}`,
  };
}

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function inRange(iso: string, from: string, to: string): boolean {
  return iso >= from && iso <= to;
}
