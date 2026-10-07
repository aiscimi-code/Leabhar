/**
 * Where the rules catalogue lives and which entries it holds. Kept apart from
 * `catalogue.ts`, which reads and loads entries, so that opening the rules
 * store (`visibleRules.ts`), which only hashes the entry files, does not pull
 * in the load pipeline.
 */
import { join } from 'node:path';
import { appRoot } from '@/lib/paths';

export const CATALOGUE_DIR = 'catalogue';

/** Every entry the app loads, as a path relative to `catalogue/`. */
export const CATALOGUE_ENTRIES = [
  'vatca-2010-revised/s046.json',
  // The Acts that inserted s.46(1)(cb) for 2020-2023 and moved its end date:
  // the revised s.46 no longer holds that wording (#688).
  'finance-act-2020/s39.json',
  'finance-covid-2021/s6.json',
  'finance-covid-2022/s7.json',
  'finance-act-2023/s5.json',
  'vatca-2010-revised/s047.json',
  'vatca-2010-revised/s009.json',
  'vatca-2010-revised/s010.json',
  'vatca-2010-revised/s030.json',
  'vatca-2010-revised/s035.json',
  'vatca-2010-revised/s080.json',
  'vatca-2010-revised/s097.json',
  'vatca-2010-revised/s043.json',
  'vatca-2010-revised/s060.json',
  'vatca-2010-revised/s061.json',
  'vatca-2010-revised/s062.json',
  'vatca-2010-revised/s066.json',
  'vatca-2010-revised/s067.json',
  'vatca-2010-revised/s069.json',
  'vatca-2010-revised/s070.json',
  'vatca-2010-revised/s086.json',
  'vatca-2010-revised/s087.json',
  'vatca-2010-revised/s088.json',
  'vatca-2010-revised/s089.json',
  'vatca-2010-revised/s002.json',
  'vatca-2010-revised/s003.json',
  'vatca-2010-revised/s037.json',
  'vatca-2010-revised/s045.json',
  'vatca-2010-revised/s076.json',
  'vatca-2010-revised/s92A.json',
  'vatca-2010-revised/s034.json',
  'vatca-2010-revised/s099.json',
  'vatca-2010-revised/s074.json',
  'vatca-2010-revised/s075.json',
  'vatca-2010-revised/s021.json',
  'vatca-2010-revised/s027.json',
  'vatca-2010-revised/s042.json',
  'vatca-2010-revised/s044.json',
  'vatca-2010-revised/s039.json',
  // NTMA (Miscellaneous Provisions) Act 2026 removed the NAMA provisions from
  // these four on 1 August 2026; no rule's dates move (#689).
  'vatca-2010-revised/s016.json',
  'vatca-2010-revised/s059.json',
  'vatca-2010-revised/s064.json',
  'vatca-2010-revised/s094.json',
  // Schedules 1-3: one provision per paragraph, under its Part.
  'vatca-2010-revised/schedule-1.json',
  'vatca-2010-revised/schedule-2.json',
  'vatca-2010-revised/schedule-3.json',
  // The Act as enacted, from the Irish Statute Book PDF: one provision per section.
  'vatca-2010/vatca-2010-enacted.json',
  // The Finance Acts as enacted, from the Irish Statute Book PDFs: one provision per section.
  'finance-act-2024/2024-act-43-enacted.json',
  'finance-act-2025/2025-act-18-enacted.json',
  // TCA 1997 sections, one page each: s.530 (RCT) and s.284 as enacted;
  // ss.530A-530I as Finance Act 2011 s.20 inserted them, each its own source
  // with that Act's page beside it; and Finance Act 2003 s.23 (the 12.5%
  // wear-and-tear rate).
  'tca-1997/s530.json',
  'tca-1997/s530A.json',
  'tca-1997/s530E.json',
  'tca-1997/s530G.json',
  'tca-1997/s530H.json',
  'tca-1997/s530I.json',
  'tca-1997/s284.json',
  'finance-act-2003/s23.json',
  // Revenue's RCT manuals (Tax and Duty Manual Part 18-02-04, -05, -11),
  // each one whole-document provision, with the PDF beside it.
  'rct/tdm-18-02-04.json',
  'rct/tdm-18-02-05.json',
  'rct/tdm-18-02-11.json',
  // Statutory instruments as made, from their Irish Statute Book pages: the
  // regulations books already hold (S.I. 156/2012's 1, 2 and 4, #705; S.I.
  // 69/2025's 5, 7, 8 and 9), each one provision.
  'si-639-2010/2010-si-639.json',
  'si-156-2012/2012-si-156.json',
  'si-69-2025/2025-si-69.json',
  // Revenue's VAT registration manual (Tax and Duty Manual Part 38-01-03b):
  // only its capacity exclusion passage, one provision, with the PDF beside it.
  'tdm-38-01-03b/38-01-03b.json',
  // Companies Act 2014 sections, revised, each one provision from its LRC page.
  'companies-act-2014/s282.json',
  'companies-act-2014/s280A.json',
  'companies-act-2014/s280B.json',
  'companies-act-2014/s280C.json',
  'companies-act-2014/s280D.json',
  'companies-act-2014/s280E.json',
  'companies-act-2014/s280F.json',
  'companies-act-2014/s352.json',
  'companies-act-2014/s358.json',
  'companies-act-2014/s359.json',
  'companies-act-2014/s360.json',
  'companies-act-2014/s281.json',
  'companies-act-2014/s283.json',
  'companies-act-2014/s284.json',
  'companies-act-2014/s285.json',
  'companies-act-2014/s286.json',
  'companies-act-2014/s290.json',
  'companies-act-2014/s291.json',
  'companies-act-2014/s292.json',
  'companies-act-2014/s293.json',
  'companies-act-2014/s343.json',
  'companies-act-2014/s347.json',
  // Revenue's Notes for Guidance on the TCA 1997, one entry per part with its
  // PDF beside it: the section notes the corporation tax rules quote.
  'tca-1997-nfg/part01.json',
  'tca-1997-nfg/part02.json',
  'tca-1997-nfg/part04.json',
  'tca-1997-nfg/part09.json',
  'tca-1997-nfg/part11.json',
  'tca-1997-nfg/part11c.json',
  'tca-1997-nfg/part12.json',
  'tca-1997-nfg/part13.json',
  'tca-1997-nfg/part15.json',
  'tca-1997-nfg/part18.json',
  'tca-1997-nfg/part18d.json',
  'tca-1997-nfg/part23.json',
  'tca-1997-nfg/part36.json',
  'tca-1997-nfg/part41a.json',
  'tca-1997-nfg/part43.json',
  // Social Welfare Consolidation Act 2005 ss.20-23 (PRSI Class S), revised,
  // each one provision from its LRC page.
  'swca-2005/s20.json',
  'swca-2005/s21.json',
  'swca-2005/s22.json',
  'swca-2005/s23.json',
  // Payroll acts whose figures the Class A rules quote: SWCA s.13, SWMPA 2024 s.3,
  // Social Welfare Act 2024 s.2, the 2025 threshold Act s.2, and NTF Act 2000 s.4.
  'swca-2005/s13.json',
  'swmpa-2024/s3.json',
  'swa-2024/s2.json',
  'swaerss-2025/s2.json',
  'ntf-2000/s4.json',
  // Employment regulations and the ERR manual the payroll rules quote.
  'si-345-2018/2018-si-345.json',
  'si-1-2024/2024-si-1.json',
  'si-510-2018/2018-si-510.json',
  'tdm-38-03-33/38-03-33.json',
  // Company size criteria (issue #555).
  'si-301-2024/2024-si-301.json',
  // Revenue's VAT3 and RTD form guidance: the VAT3 page's box passages (its
  // HTML beside it) and the RTD manual's curated sections (its PDF).
  'vat3-rtd/completing-vat3-return.json',
  'vat3-rtd/VAT-RTD-S76.json',
  // Revenue eBrief No. 168/25: the notice, one provision, its page beside it.
  'ebriefs/no-168-25.json',
  // Council Implementing Regulation (EU) No 282/2011 arts. 10-13b: the
  // establishment tests, from the EUR-Lex consolidated text kept beside it.
  'eu-282-2011/consolidated-2025-04-14.json',
  // S.I. 312/1996 art. 92 (the Class S prescribed amount): the article cut
  // from the LRC page of the whole instrument, kept beside it (#712).
  'si-312-1996/art92.json',
  // Revenue TDM Part 11-00-01 §6 (the 2008 car CO2 groups), its PDF beside it.
  'tdm-11-00-01/11-00-01.json',
] as const;

export function catalogueEntryPath(entry: string, root: string = appRoot()): string {
  return join(root, CATALOGUE_DIR, entry);
}
