/** Integer cents. No floating point in a figure that will be filed. */

const eur = new Intl.NumberFormat("en-IE", {
  style: "currency",
  currency: "EUR",
});

export function formatMoney(minor: number, currency = "EUR"): string {
  if (currency === "EUR") return eur.format(minor / 100);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  return `${sign}${(abs / 100).toFixed(2)} ${currency}`;
}

export function parseMoneyToMinor(raw: string): number | null {
  let s = raw.trim().replace(/[€£$\s]/g, "");
  if (!s || s === "-" || s === ".") return null;
  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  }
  if (s.endsWith("-")) {
    neg = true;
    s = s.slice(0, -1);
  }
  if (!s) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma !== -1 && lastComma > lastDot) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const centsText = (frac + "00").slice(0, 2);
  let minor = Number(whole) * 100 + Number(centsText);
  if (frac.length > 2 && Number(frac[2]) >= 5) minor += 1;
  if (!Number.isSafeInteger(minor)) return null;
  return neg ? -minor : minor;
}

/** VAT-inclusive split. rateBps 2300 = 23.00%. Half-up on the cent. */
export function splitVatInclusive(
  grossMinor: number,
  rateBps: number,
): { netMinor: number; vatMinor: number } {
  const abs = Math.abs(grossMinor);
  const vat = Math.round((abs * rateBps) / (10_000 + rateBps));
  const net = abs - vat;
  const sign = grossMinor < 0 ? -1 : 1;
  return { netMinor: net * sign, vatMinor: vat * sign };
}

/** VAT on a VAT-exclusive amount (reverse charge). */
export function vatOnExclusive(netMinor: number, rateBps: number): number {
  const abs = Math.abs(netMinor);
  const vat = Math.round((abs * rateBps) / 10_000);
  return netMinor < 0 ? -vat : vat;
}
