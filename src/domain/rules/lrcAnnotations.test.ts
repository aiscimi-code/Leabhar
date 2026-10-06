import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sha256Hex } from '@/lib/hash';
import { readCatalogueEntry } from './catalogue';
import { annotateScheduleParagraphs, parseLrcFootnotes, scheduleParagraphWindows, UNNUMBERED_PARAGRAPHS } from './lrcAnnotations';
import { UNNUMBERED_SCHEDULE_PARAGRAPHS } from './coverage';

/**
 * Issue #205: each schedule paragraph's rule window comes from the LRC's own
 * amendment footnotes, read from the LRC page kept beside its rules
 * catalogue entry (#556), in the order the entry lists the paragraphs.
 */

const DIR = 'catalogue/vatca-2010-revised';
const html = (n: string) => readFileSync(`${DIR}/schedule-${n}.html`, 'utf8');
const entry = (n: string) => readCatalogueEntry(`vatca-2010-revised/schedule-${n}.json`);
const paragraphs = (n: string) => entry(n).provisions.map((p) => p.sectionNumber);

describe('LRC schedule annotations', () => {
  it('reads the page the entry was extracted from', () => {
    for (const n of ['2', '3']) {
      expect(sha256Hex(readFileSync(`${DIR}/schedule-${n}.html`))).toBe(entry(n).source.sha256);
    }
  });

  it('parses footnote dates in every form the LRC uses', () => {
    const notes = parseLrcFootnotes(html('2'));
    expect(notes.get('F418')).toMatchObject({ kind: 'Substituted', date: '2020-01-01' });
    expect(notes.get('F425')?.date).toBe('2021-12-12'); // "(1.01.2021, 12.12.2021)": the later date
    expect(notes.get('F442')?.date).toBe('2022-01-01'); // "(1.01.2022, deemed)"
    expect(notes.get('F443')?.date).toBe('2021-12-21'); // "(21.12.21)"
    expect(notes.get('F441')).toMatchObject({ kind: 'unspecified', date: '2020-12-19' });
    for (const n of ['2', '3']) {
      for (const note of parseLrcFootnotes(html(n)).values()) expect(note.date, `${n} ${note.ref}`).not.toBeNull();
    }
  });

  it('finds every paragraph the schedule parser finds, and places every footnote', () => {
    for (const n of ['2', '3']) {
      const list = paragraphs(n);
      for (const u of UNNUMBERED_PARAGRAPHS[n] ?? []) {
        if (!list.includes(u.paragraph)) list.splice(list.indexOf(u.before), 0, u.paragraph);
      }
      const startsAt = Object.fromEntries((UNNUMBERED_PARAGRAPHS[n] ?? []).map((u) => [u.paragraph, u.heading]));
      const result = annotateScheduleParagraphs(html(n), list, startsAt);
      const placed = new Set([...result.paragraphs.flatMap((p) => p.footnotes.map((f) => f.ref)), ...result.partFootnotes.map((f) => f.ref)]);
      expect([...parseLrcFootnotes(html(n)).keys()].filter((ref) => !placed.has(ref))).toEqual([]);
    }
  });

  it('dates a paragraph from its latest amendment', () => {
    const s3 = scheduleParagraphWindows(html('3'), '3', paragraphs('3'));
    expect(s3.get('17')?.effectiveFrom).toBe('2017-12-25');
    expect(s3.get('16')?.effectiveFrom).toBe('2025-12-23');
    expect(s3.get('21')).toMatchObject({ effectiveFrom: '2018-01-01' }); // the unnumbered paragraph (F481)
    expect(s3.get('21')!.footnotes.map((f) => f.ref)).toContain('F481');
    // Never amended: from the Act's commencement.
    expect(s3.get('19')).toEqual({ effectiveFrom: '2010-11-01', footnotes: [] });
  });

  it('dates a paragraph in an inserted Part from the Part\'s insertion, and ignores a reworded Part heading', () => {
    const s3 = scheduleParagraphWindows(html('3'), '3', paragraphs('3'));
    expect(s3.get('13A')?.effectiveFrom).toBe('2012-03-01'); // Part 2A inserted (F469)
    expect(s3.get('13B')?.effectiveFrom).toBe('2015-01-01'); // Part 2B inserted (F471)
    // The 1.01.2025 rewording of Part headings (S.I. 725/2024) changes no paragraph.
    expect(s3.get('23')?.effectiveFrom).toBe('2010-11-01');
    expect(s3.get('22')?.effectiveFrom).toBe('2012-03-31');
  });

  it('keeps the unnumbered paragraph list in step with the coverage matrix', () => {
    expect(UNNUMBERED_SCHEDULE_PARAGRAPHS.map((u) => u.id)).toEqual(
      Object.entries(UNNUMBERED_PARAGRAPHS).flatMap(([n, list]) => list.map((u) => `vatca:sch${n}:p4:${u.paragraph}`)),
    );
  });
});
