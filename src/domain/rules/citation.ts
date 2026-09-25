/**
 * "2010 Act 31" + "12" → "2010 Act 31 s.12"; "2010 Act 31 Sch.1" + "6" →
 * "2010 Act 31 Sch.1 para 6". Revised-text sources already carry the section
 * in their citation ("2010 Act 31 s.46"), so it is not repeated.
 */
export function provisionCitation(citation: string, sectionNumber: string): string {
  if (sectionNumber === 'full' || citation.endsWith(` s.${sectionNumber}`)) return citation;
  if (/\bSch\.\d+$/.test(citation)) return `${citation} para ${sectionNumber}`;
  return `${citation} s.${sectionNumber}`;
}
