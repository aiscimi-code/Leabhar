import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { importStatement } from './import';
import { parseOfx, parseCamt053, detectStatementFormat } from './structuredStatements';
import { reconcileBankAccount } from './reconciliation';
import { bankTransactions, statementImports } from '@/db/schema';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

// OFX 1.x: SGML, value elements have no closing tag.
const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
ENCODING:USASCII
CHARSET:1252

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20250401</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STMTRS>
<CURDEF>EUR
<BANKACCTFROM><BANKID>AIBKIE2D<ACCTID>IE29AIBK93115212345678<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20250301<DTEND>20250331
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20250303120000[0:GMT]<TRNAMT>-123.00<FITID>AIB-0001<NAME>Eircom<MEMO>Broadband March</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20250310<TRNAMT>1500.00<FITID>AIB-0002<NAME>Client Ltd<REFNUM>INV-7</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20250312<TRNAMT>-4.50<FITID>AIB-0003<NAME>Bank fee</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1372.50<DTASOF>20250331</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>
`;

// OFX 2.x: XML, a credit card statement.
const OFX_XML_CARD = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="220"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>
<CURDEF>EUR</CURDEF>
<CCACCTFROM><ACCTID>4111XXXX1111</ACCTID></CCACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20250405</DTPOSTED><TRNAMT>-59.99</TRNAMT><FITID>CC-1</FITID><NAME>Software &amp; Co</NAME></STMTTRN>
<STMTTRN><TRNTYPE>BOGUS</TRNTYPE><DTPOSTED>20250406</DTPOSTED><FITID>CC-2</FITID><NAME>No amount</NAME></STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>-59.99</BALAMT><DTASOF>20250430</DTASOF></LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

// CAMT.053 (v2 layout: Sts as text, Cdtr/Nm), with a namespace prefix.
const CAMT_V2 = `<?xml version="1.0" encoding="UTF-8"?>
<ns:Document xmlns:ns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
 <ns:BkToCstmrStmt>
  <ns:GrpHdr><ns:MsgId>M1</ns:MsgId></ns:GrpHdr>
  <ns:Stmt>
   <ns:Id>S1</ns:Id>
   <ns:Acct><ns:Id><ns:IBAN>IE29AIBK93115212345678</ns:IBAN></ns:Id><ns:Ccy>EUR</ns:Ccy></ns:Acct>
   <ns:Bal><ns:Tp><ns:CdOrPrtry><ns:Cd>OPBD</ns:Cd></ns:CdOrPrtry></ns:Tp>
     <ns:Amt Ccy="EUR">100.00</ns:Amt><ns:CdtDbtInd>CRDT</ns:CdtDbtInd><ns:Dt><ns:Dt>2025-03-01</ns:Dt></ns:Dt></ns:Bal>
   <ns:Bal><ns:Tp><ns:CdOrPrtry><ns:Cd>CLBD</ns:Cd></ns:CdOrPrtry></ns:Tp>
     <ns:Amt Ccy="EUR">1477.00</ns:Amt><ns:CdtDbtInd>CRDT</ns:CdtDbtInd><ns:Dt><ns:Dt>2025-03-31</ns:Dt></ns:Dt></ns:Bal>
   <ns:Ntry>
    <ns:Amt Ccy="EUR">123.00</ns:Amt><ns:CdtDbtInd>DBIT</ns:CdtDbtInd><ns:Sts>BOOK</ns:Sts>
    <ns:BookgDt><ns:Dt>2025-03-03</ns:Dt></ns:BookgDt><ns:ValDt><ns:Dt>2025-03-04</ns:Dt></ns:ValDt>
    <ns:AcctSvcrRef>REF-A</ns:AcctSvcrRef>
    <ns:NtryDtls><ns:TxDtls>
     <ns:Refs><ns:EndToEndId>E2E-1</ns:EndToEndId></ns:Refs>
     <ns:RltdPties><ns:Cdtr><ns:Nm>Eircom Ltd</ns:Nm></ns:Cdtr>
      <ns:CdtrAcct><ns:Id><ns:IBAN>IE64IRCE92050112345678</ns:IBAN></ns:Id></ns:CdtrAcct></ns:RltdPties>
     <ns:RmtInf><ns:Ustrd>Broadband March</ns:Ustrd></ns:RmtInf>
    </ns:TxDtls></ns:NtryDtls>
   </ns:Ntry>
   <ns:Ntry>
    <ns:Amt Ccy="EUR">1500.00</ns:Amt><ns:CdtDbtInd>CRDT</ns:CdtDbtInd><ns:Sts>BOOK</ns:Sts>
    <ns:BookgDt><ns:Dt>2025-03-10</ns:Dt></ns:BookgDt>
    <ns:AcctSvcrRef>REF-B</ns:AcctSvcrRef>
    <ns:AddtlNtryInf>Payment from Client Ltd</ns:AddtlNtryInf>
    <ns:NtryDtls><ns:TxDtls><ns:RltdPties><ns:Dbtr><ns:Nm>Client Ltd</ns:Nm></ns:Dbtr></ns:RltdPties></ns:TxDtls></ns:NtryDtls>
   </ns:Ntry>
   <ns:Ntry>
    <ns:Amt Ccy="EUR">20.00</ns:Amt><ns:CdtDbtInd>DBIT</ns:CdtDbtInd><ns:Sts>PDNG</ns:Sts>
    <ns:BookgDt><ns:Dt>2025-03-31</ns:Dt></ns:BookgDt><ns:AcctSvcrRef>REF-C</ns:AcctSvcrRef>
   </ns:Ntry>
  </ns:Stmt>
 </ns:BkToCstmrStmt>
</ns:Document>`;

// CAMT.053 v8+ layout: Sts/Cd and Cdtr/Pty/Nm, no prefix.
const CAMT_V8 = `<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt>
 <Acct><Id><IBAN>IE29AIBK93115212345678</IBAN></Id><Ccy>EUR</Ccy></Acct>
 <Ntry><Amt Ccy="EUR">45.10</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
  <BookgDt><DtTm>2025-06-02T09:15:00</DtTm></BookgDt><AcctSvcrRef>V8-1</AcctSvcrRef>
  <NtryDtls><TxDtls><RltdPties><Cdtr><Pty><Nm>ESB Networks</Nm></Pty></Cdtr></RltdPties></TxDtls>
   <TxDtls><RltdPties><Cdtr><Pty><Nm>Other</Nm></Pty></Cdtr></RltdPties></TxDtls></NtryDtls></Ntry>
 <Ntry><Amt Ccy="EUR">10.00</Amt><CdtDbtInd>SIDEWAYS</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts>
  <BookgDt><Dt>2025-06-03</Dt></BookgDt></Ntry>
</Stmt></BkToCstmrStmt></Document>`;

const OPTIONS = { bankAccountId: 'bka_test', defaultCurrency: 'EUR' };

describe('recognising the format', () => {
  it('reads the format from the name or the content', () => {
    expect(detectStatementFormat('march.ofx', '')).toBe('ofx');
    expect(detectStatementFormat('march.QFX', '')).toBe('ofx');
    expect(detectStatementFormat('download.txt', OFX_SGML)).toBe('ofx');
    expect(detectStatementFormat('statement.xml', CAMT_V2)).toBe('camt053');
    expect(detectStatementFormat('statement.xlsx', '')).toBe('xlsx');
    expect(detectStatementFormat('statement.csv', 'Date,Amount')).toBe('csv');
  });
});

describe('OFX (#378)', () => {
  it('reads an SGML statement: lines, bank ids, sign and closing balance', () => {
    const result = parseOfx(OFX_SGML, OPTIONS);
    expect(result.errors).toEqual([]);
    expect(result.accountIdentifier).toBe('IE29AIBK93115212345678');
    expect(result.transactions.map((t) => [t.transactionDate, t.amountMinor, t.bankTransactionId])).toEqual([
      ['2025-03-03', -12_300, 'AIB-0001'],
      ['2025-03-10', 150_000, 'AIB-0002'],
      ['2025-03-12', -450, 'AIB-0003'],
    ]);
    expect(result.transactions[0]).toMatchObject({
      description: 'Eircom — Broadband March', counterpartyName: 'Eircom', transactionType: 'debit',
    });
    expect(result.transactions[1]!.bankReference).toBe('INV-7');
    expect(result.closingBalanceMinor).toBe(137_250);
    expect(result.closingBalanceDate).toBe('2025-03-31');
  });

  it('reads an XML credit card statement, and reports a line it cannot read', () => {
    const result = parseOfx(OFX_XML_CARD, OPTIONS);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({ amountMinor: -5_999, description: 'Software & Co' });
    expect(result.errors).toEqual([expect.objectContaining({ rowNumber: 2, message: expect.stringMatching(/TRNAMT/) })]);
    expect(result.closingBalanceMinor).toBe(-5_999);
  });

  it('says so when the file holds no statement', () => {
    const result = parseOfx('<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>', OPTIONS);
    expect(result.transactions).toEqual([]);
    expect(result.warnings[0]).toMatch(/No bank or credit card statement/);
  });
});

describe('CAMT.053 (#378)', () => {
  it('reads booked entries, signs them by CdtDbtInd, and skips pending ones with a warning', () => {
    const result = parseCamt053(CAMT_V2, OPTIONS);
    expect(result.errors).toEqual([]);
    expect(result.transactions.map((t) => [t.transactionDate, t.amountMinor, t.bankTransactionId])).toEqual([
      ['2025-03-03', -12_300, 'REF-A'],
      ['2025-03-10', 150_000, 'REF-B'],
    ]);
    expect(result.transactions[0]).toMatchObject({
      description: 'Broadband March', counterpartyName: 'Eircom Ltd',
      counterpartyIban: 'IE64IRCE92050112345678', bankReference: 'E2E-1', valueDate: '2025-03-04',
    });
    // On a credit the counterparty is the debtor, who paid.
    expect(result.transactions[1]).toMatchObject({
      description: 'Payment from Client Ltd', counterpartyName: 'Client Ltd',
    });
    expect(result.warnings.join(' ')).toMatch(/1 entry is not yet booked/);
    expect(result).toMatchObject({
      openingBalanceMinor: 10_000, closingBalanceMinor: 147_700, closingBalanceDate: '2025-03-31',
      accountIdentifier: 'IE29AIBK93115212345678', statementCurrency: 'EUR',
    });
  });

  it('reads the v8 layout, a batch entry, and reports an entry with a bad indicator', () => {
    const result = parseCamt053(CAMT_V8, OPTIONS);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      transactionDate: '2025-06-02', amountMinor: -4_510, counterpartyName: 'ESB Networks',
      notes: 'A batch of 2 payments booked as one entry.',
    });
    expect(result.errors).toEqual([expect.objectContaining({ rowNumber: 2, message: expect.stringMatching(/CRDT or DBIT/) })]);
  });

  it('says so when the file is not a statement', () => {
    const result = parseCamt053('<Document><BkToCstmrAcctRpt><Rpt/></BkToCstmrAcctRpt></Document>', OPTIONS);
    expect(result.warnings[0]).toMatch(/not a statement/);
  });
});

describe('importing and reconciling a structured statement', () => {
  let db: AppDatabase;
  let companyId: string;
  let bankAccountId: string;

  beforeEach(() => {
    ({ db } = createTestDatabase());
    companyId = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] }).companyId;
    bankAccountId = addBankAccount(db, {
      companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2025-01-01',
    });
  });

  it('imports CAMT once, keeps the balances with the import, and skips it the second time', async () => {
    const first = await importStatement(db, {
      companyId, bankAccountId, filename: 'march.xml', content: CAMT_V2, fileFormat: 'camt053',
    });
    expect(first).toMatchObject({ imported: 2, duplicates: 0, failed: 0, statementEndDate: '2025-03-31' });
    const run = db.select().from(statementImports).where(eq(statementImports.id, first.importId)).get()!;
    expect(run).toMatchObject({ fileFormat: 'camt053', openingBalanceMinor: 10_000, closingBalanceMinor: 147_700 });

    // The same file again: the file hash stops it before any line is read.
    const again = await importStatement(db, {
      companyId, bankAccountId, filename: 'march.xml', content: CAMT_V2, fileFormat: 'camt053',
    });
    expect(again.imported).toBe(0);
    expect(db.select().from(bankTransactions).all()).toHaveLength(2);
  });

  it('reconciles against the bank\'s own closing balance for that date', async () => {
    await importStatement(db, {
      companyId, bankAccountId, filename: 'march.ofx', content: OFX_SGML, fileFormat: 'ofx',
    });
    const rec = reconcileBankAccount(db, {
      companyId, bankAccountId, periodStart: makeDate(2025, 3, 1), periodEnd: makeDate(2025, 3, 31),
    });
    expect(rec.statementBalanceSource).toBe('statement_closing_balance');
    expect(rec.statementBalanceMinor).toBe(137_250);

    // A different date is not covered by that statement's closing balance.
    const other = reconcileBankAccount(db, {
      companyId, bankAccountId, periodStart: makeDate(2025, 3, 1), periodEnd: makeDate(2025, 3, 30),
    });
    expect(other.statementBalanceSource).not.toBe('statement_closing_balance');
  });
});
