import { describe, it, expect } from 'vitest';
import { toCsv, amountFor, type ExportColumn } from './exports';

interface Row { name: string; amountMinor: number | null; note: string }

const columns: Array<ExportColumn<Row>> = [
  { header: 'Name', value: (r) => r.name },
  { header: 'Amount', money: true, value: (r) => amountFor(r.amountMinor) },
  { header: 'Note', value: (r) => r.note },
];

const row = (over: Partial<Row> = {}): Row => ({
  name: 'Vercel Inc', amountMinor: 4217, note: 'Hosting', ...over,
});

describe('amountFor', () => {
  it('converts minor units to a decimal number', () => {
    expect(amountFor(123_456)).toBe(1234.56);
    expect(amountFor(-4_217)).toBe(-42.17);
    expect(amountFor(0)).toBe(0);
  });

  it('respects currencies with other exponents', () => {
    expect(amountFor(1234, 'JPY')).toBe(1234);
  });

  it('passes null through rather than writing a zero', () => {
    expect(amountFor(null)).toBeNull();
    expect(amountFor(undefined)).toBeNull();
  });
});

describe('toCsv', () => {
  it('writes a header row and the values', () => {
    const csv = toCsv([row()], columns);
    expect(csv).toContain('Name,Amount,Note');
    expect(csv).toContain('Vercel Inc,42.17,Hosting');
  });

  it('starts with a BOM so Excel reads UTF-8 correctly', () => {
    expect(toCsv([row()], columns).startsWith('﻿')).toBe(true);
  });

  it('quotes values containing commas, quotes or newlines', () => {
    expect(toCsv([row({ name: 'Byrne, Murphy & Co' })], columns))
      .toContain('"Byrne, Murphy & Co"');
    expect(toCsv([row({ note: 'He said "hello"' })], columns))
      .toContain('"He said ""hello"""');
    expect(toCsv([row({ note: 'line one\nline two' })], columns))
      .toContain('"line one\nline two"');
  });

  it('writes an empty cell for null rather than the word null', () => {
    const csv = toCsv([row({ amountMinor: null })], columns);
    expect(csv).toContain('Vercel Inc,,Hosting');
    expect(csv).not.toContain('null');
  });

  // A bank description beginning with = becomes executable when the exported
  // file is opened in a spreadsheet application.
  it('neutralises values that a spreadsheet would treat as a formula', () => {
    for (const dangerous of ['=1+1', '+1', '-1', '@SUM(A1)']) {
      const csv = toCsv([row({ note: dangerous })], columns);
      expect(csv).toContain(`'${dangerous}`);
      expect(csv).not.toContain(`,${dangerous}\r\n`);
    }
  });

  it('leaves a negative number written by an amount column intact', () => {
    // The amount column emits a number, so it is not treated as text.
    const csv = toCsv([row({ amountMinor: -4217 })], columns);
    expect(csv).toContain('-42.17');
  });

  it('uses CRLF line endings', () => {
    expect(toCsv([row(), row()], columns).split('\r\n')).toHaveLength(4);
  });

  it('handles an empty result set', () => {
    const csv = toCsv([], columns);
    expect(csv).toBe('﻿Name,Amount,Note\r\n');
  });
});
