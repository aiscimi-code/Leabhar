import { parseAmount } from '../money';
import { asIsoDate, type IsoDate } from '../dates';
import { transactionFingerprint } from './fingerprint';
import type { ParsedTransaction, ParseResult, RowError } from './statementParser';

/**
 * Structured bank statement formats (issue #378): OFX (1.x SGML and 2.x XML)
 * and ISO 20022 CAMT.053, the bank-to-customer statement Irish and EU banks
 * offer.
 *
 * Both are reduced to the same `ParsedTransaction` rows the CSV path produces,
 * so fingerprints, both duplicate defences, FX handling and the audit trail
 * are shared. Unlike a CSV, both carry the bank's own transaction id and the
 * statement's balances, and both are read exactly as the bank wrote them:
 * nothing is guessed, and a row that cannot be read is reported, not skipped.
 */

export type StatementFormat = 'csv' | 'xlsx' | 'ofx' | 'camt053';

export interface StructuredStatement extends ParseResult {
  /** The currency the statement is kept in, as the file states it. */
  statementCurrency: string | null;
  /** The account the file says it is for (IBAN or account number), if given. */
  accountIdentifier: string | null;
  openingBalanceMinor: number | null;
  closingBalanceMinor: number | null;
  /** The date the closing balance is struck at. */
  closingBalanceDate: IsoDate | null;
}

export interface StructuredParseOptions {
  bankAccountId: string;
  /** The bank account's currency, used where the file names none. */
  defaultCurrency: string;
}

/** Recognise a statement file's format from its name and first bytes. */
export function detectStatementFormat(filename: string, content: Buffer | string): StatementFormat {
  const name = filename.toLowerCase();
  if (name.endsWith('.xlsx')) return 'xlsx';
  if (name.endsWith('.ofx') || name.endsWith('.qfx')) return 'ofx';
  const head = (typeof content === 'string' ? content : content.subarray(0, 4096).toString('utf8'))
    .slice(0, 4096);
  if (/OFXHEADER|<OFX>/i.test(head)) return 'ofx';
  if (/camt\.053|<BkToCstmrStmt/i.test(head)) return 'camt053';
  if (name.endsWith('.xml') && /camt\.05/i.test(head)) return 'camt053';
  return 'csv';
}

// ---------------------------------------------------------------------------
// A small tree reader shared by both formats
// ---------------------------------------------------------------------------

interface Node {
  name: string;
  attrs: Record<string, string>;
  children: Node[];
  text: string;
}

const child = (node: Node | undefined, name: string): Node | undefined =>
  node?.children.find((c) => c.name === name);

const path = (node: Node | undefined, ...names: string[]): Node | undefined =>
  names.reduce<Node | undefined>((n, name) => child(n, name), node);

const textAt = (node: Node | undefined, ...names: string[]): string | null => {
  const found = path(node, ...names);
  const value = found?.text.trim();
  return value ? value : null;
};

function all(node: Node, name: string, into: Node[] = []): Node[] {
  for (const c of node.children) {
    if (c.name === name) into.push(c);
    all(c, name, into);
  }
  return into;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Read well-formed XML (CAMT) into a tree. Namespace prefixes are dropped —
 * banks use different prefixes for the same schema — and comments, the XML
 * declaration and processing instructions are skipped.
 */
function readXml(content: string): Node {
  const root: Node = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: Node[] = [root];
  const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(content)) !== null) {
    const [, cdata, closing, rawName, rawAttrs, selfClosing, text] = match;
    const top = stack[stack.length - 1]!;
    if (cdata !== undefined) { top.text += cdata; continue; }
    if (text !== undefined) { top.text += decodeEntities(text); continue; }
    if (!rawName) continue;
    const name = rawName.includes(':') ? rawName.slice(rawName.indexOf(':') + 1) : rawName;
    if (closing) {
      const at = stack.map((n) => n.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (rawAttrs ?? '').matchAll(/([\w.:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const key = a[1]!.includes(':') ? a[1]!.slice(a[1]!.indexOf(':') + 1) : a[1]!;
      attrs[key] = decodeEntities(a[3] ?? a[4] ?? '');
    }
    const node: Node = { name, attrs, children: [], text: '' };
    top.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

/**
 * Read OFX into a tree. OFX 1.x is SGML: an element holding a value has no
 * closing tag (`<TRNAMT>-12.30`), while an aggregate does (`</STMTTRN>`). OFX
 * 2.x is XML and closes both. A tag followed by text is therefore a leaf; a
 * tag followed directly by another tag opens an aggregate; a closing tag
 * closes the nearest aggregate of that name and is ignored otherwise.
 */
function readOfx(content: string): Node {
  const start = content.search(/<OFX>/i);
  const body = start >= 0 ? content.slice(start) : content;
  const root: Node = { name: '#root', attrs: {}, children: [], text: '' };
  const stack: Node[] = [root];
  for (const match of body.matchAll(/<(\/?)([A-Za-z0-9.]+)[^>]*>([^<]*)/g)) {
    const [, closing, rawName, rawText] = match;
    const name = rawName!.toUpperCase();
    const text = decodeEntities(rawText ?? '').trim();
    const top = stack[stack.length - 1]!;
    if (closing) {
      const at = stack.map((n) => n.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }
    const node: Node = { name, attrs: {}, children: [], text };
    top.children.push(node);
    if (text === '') stack.push(node);
  }
  return root;
}

// ---------------------------------------------------------------------------
// OFX
// ---------------------------------------------------------------------------

/** OFX dates are YYYYMMDD, optionally followed by a time and a zone. */
function ofxDate(value: string | null): IsoDate | null {
  if (!value) return null;
  const digits = /^(\d{4})(\d{2})(\d{2})/.exec(value.trim());
  if (!digits) throw new Error(`"${value}" is not an OFX date.`);
  return asIsoDate(`${digits[1]}-${digits[2]}-${digits[3]}`);
}

export function parseOfx(content: string, options: StructuredParseOptions): StructuredStatement {
  const tree = readOfx(content);
  const statement = all(tree, 'STMTRS')[0] ?? all(tree, 'CCSTMTRS')[0];
  const warnings: string[] = [];
  const errors: RowError[] = [];
  const transactions: ParsedTransaction[] = [];

  if (!statement) {
    return {
      transactions, errors, headers: [], rowsRead: 0,
      warnings: ['No bank or credit card statement was found in this OFX file.'],
      statementCurrency: null, accountIdentifier: null,
      openingBalanceMinor: null, closingBalanceMinor: null, closingBalanceDate: null,
    };
  }
  if (all(tree, 'STMTRS').length + all(tree, 'CCSTMTRS').length > 1) {
    warnings.push('This file holds more than one statement. Only the first was read; import the others separately.');
  }

  const currency = (textAt(statement, 'CURDEF') ?? options.defaultCurrency).toUpperCase();
  if (currency !== options.defaultCurrency.toUpperCase()) {
    warnings.push(`The statement is in ${currency} but the bank account is in ${options.defaultCurrency}. Check the file is for this account.`);
  }
  const accountIdentifier = textAt(statement, 'BANKACCTFROM', 'ACCTID')
    ?? textAt(statement, 'CCACCTFROM', 'ACCTID');

  const lines = all(statement, 'STMTTRN');
  for (const [index, line] of lines.entries()) {
    const rowNumber = index + 1;
    const raw: Record<string, string> = {};
    for (const c of line.children) if (c.text) raw[c.name] = c.text;
    try {
      const transactionDate = ofxDate(textAt(line, 'DTPOSTED'));
      if (!transactionDate) throw new Error('No posting date (DTPOSTED).');
      const amountText = textAt(line, 'TRNAMT');
      if (!amountText) throw new Error('No amount (TRNAMT).');
      const amountMinor = parseAmount(amountText, currency, { decimalSeparator: amountText.includes(',') && !amountText.includes('.') ? ',' : '.' });
      const name = textAt(line, 'NAME') ?? textAt(line, 'PAYEE', 'NAME');
      const memo = textAt(line, 'MEMO');
      const description = [name, memo && memo !== name ? memo : null].filter(Boolean).join(' — ')
        || textAt(line, 'TRNTYPE') || '(no description)';
      const bankTransactionId = textAt(line, 'FITID');
      const bankReference = textAt(line, 'REFNUM') ?? textAt(line, 'CHECKNUM');
      transactions.push({
        rowNumber,
        transactionDate,
        valueDate: ofxDate(textAt(line, 'DTAVAIL')),
        description,
        amountMinor,
        currency,
        baseAmountMinor: null,
        balanceAfterMinor: null,
        bankReference,
        bankTransactionId,
        counterpartyName: name,
        counterpartyIban: null,
        transactionType: textAt(line, 'TRNTYPE')?.toLowerCase() ?? null,
        notes: path(line, 'ORIGCURRENCY') ? 'The bank converted this line from another currency.' : null,
        fingerprint: transactionFingerprint({
          bankAccountId: options.bankAccountId, transactionDate, amountMinor, currency,
          description, bankReference, bankTransactionId,
        }),
        rawData: raw,
      });
    } catch (error) {
      errors.push({ rowNumber, message: error instanceof Error ? error.message : String(error), raw });
    }
  }

  const ledger = child(statement, 'LEDGERBAL');
  const closingText = textAt(ledger, 'BALAMT');
  return {
    transactions, errors, warnings, headers: [], rowsRead: lines.length,
    statementCurrency: currency,
    accountIdentifier,
    openingBalanceMinor: null,
    closingBalanceMinor: closingText ? parseAmount(closingText, currency) : null,
    closingBalanceDate: ofxDate(textAt(ledger, 'DTASOF')),
  };
}

// ---------------------------------------------------------------------------
// CAMT.053
// ---------------------------------------------------------------------------

/** A CAMT amount with its credit/debit indicator, signed from the account holder's side. */
function camtAmount(amountNode: Node | undefined, indicator: string | null, fallbackCurrency: string): {
  amountMinor: number; currency: string;
} {
  if (!amountNode?.text.trim()) throw new Error('No amount (Amt).');
  const currency = (amountNode.attrs.Ccy ?? fallbackCurrency).toUpperCase();
  const magnitude = parseAmount(amountNode.text.trim(), currency);
  if (indicator !== 'CRDT' && indicator !== 'DBIT') {
    throw new Error(`The credit/debit indicator is "${indicator ?? ''}", not CRDT or DBIT.`);
  }
  return { amountMinor: indicator === 'DBIT' ? -magnitude : magnitude, currency };
}

function camtDate(node: Node | undefined): IsoDate | null {
  const value = textAt(node, 'Dt') ?? textAt(node, 'DtTm');
  return value ? asIsoDate(value.slice(0, 10)) : null;
}

/** A party's name under v2 (`Cdtr/Nm`) or v8+ (`Cdtr/Pty/Nm`) layouts. */
function partyName(party: Node | undefined): string | null {
  return textAt(party, 'Nm') ?? textAt(party, 'Pty', 'Nm');
}

function partyIban(account: Node | undefined): string | null {
  return textAt(account, 'Id', 'IBAN');
}

export function parseCamt053(content: string, options: StructuredParseOptions): StructuredStatement {
  const tree = readXml(content);
  const statements = all(tree, 'Stmt');
  const warnings: string[] = [];
  const errors: RowError[] = [];
  const transactions: ParsedTransaction[] = [];
  const statement = statements[0];

  if (!statement) {
    return {
      transactions, errors, headers: [], rowsRead: 0,
      warnings: ['No statement (Stmt) was found in this CAMT file. A camt.052 report or camt.054 notification is not a statement.'],
      statementCurrency: null, accountIdentifier: null,
      openingBalanceMinor: null, closingBalanceMinor: null, closingBalanceDate: null,
    };
  }
  if (statements.length > 1) {
    warnings.push('This file holds more than one statement. Only the first was read; import the others separately.');
  }

  const accountIdentifier = textAt(statement, 'Acct', 'Id', 'IBAN') ?? textAt(statement, 'Acct', 'Id', 'Othr', 'Id');
  const currency = (textAt(statement, 'Acct', 'Ccy') ?? options.defaultCurrency).toUpperCase();
  if (currency !== options.defaultCurrency.toUpperCase()) {
    warnings.push(`The statement is in ${currency} but the bank account is in ${options.defaultCurrency}. Check the file is for this account.`);
  }

  // Balances: opening booked (OPBD, or the previous closing PRCD) and closing booked (CLBD).
  let openingBalanceMinor: number | null = null;
  let closingBalanceMinor: number | null = null;
  let closingBalanceDate: IsoDate | null = null;
  for (const balance of statement.children.filter((c) => c.name === 'Bal')) {
    const code = textAt(balance, 'Tp', 'CdOrPrtry', 'Cd');
    const { amountMinor } = camtAmount(child(balance, 'Amt'), textAt(balance, 'CdtDbtInd'), currency);
    if (code === 'OPBD' || (code === 'PRCD' && openingBalanceMinor === null)) openingBalanceMinor = amountMinor;
    if (code === 'CLBD') {
      closingBalanceMinor = amountMinor;
      closingBalanceDate = camtDate(child(balance, 'Dt'));
    }
  }

  const entries = statement.children.filter((c) => c.name === 'Ntry');
  let pending = 0;
  for (const [index, entry] of entries.entries()) {
    const rowNumber = index + 1;
    const raw: Record<string, string> = {};
    try {
      const status = textAt(entry, 'Sts', 'Cd') ?? textAt(entry, 'Sts');
      if (status && status !== 'BOOK') { pending += 1; continue; }

      const indicator = textAt(entry, 'CdtDbtInd');
      const { amountMinor, currency: entryCurrency } = camtAmount(child(entry, 'Amt'), indicator, currency);
      const transactionDate = camtDate(child(entry, 'BookgDt'));
      if (!transactionDate) throw new Error('No booking date (BookgDt).');

      const detail = path(entry, 'NtryDtls', 'TxDtls');
      const parties = child(detail, 'RltdPties');
      // The other side of the movement: who was paid on a debit, who paid on a credit.
      const counterparty = indicator === 'DBIT' ? child(parties, 'Cdtr') : child(parties, 'Dbtr');
      const counterpartyAccount = indicator === 'DBIT' ? child(parties, 'CdtrAcct') : child(parties, 'DbtrAcct');
      const counterpartyName = partyName(counterparty);
      const unstructured = child(detail, 'RmtInf')?.children
        .filter((c) => c.name === 'Ustrd').map((c) => c.text.trim()).filter(Boolean).join(' ') || null;
      const additional = textAt(entry, 'AddtlNtryInf');
      const description = additional ?? unstructured ?? counterpartyName ?? '(no description)';
      const bankTransactionId = textAt(entry, 'AcctSvcrRef') ?? textAt(detail, 'Refs', 'AcctSvcrRef');
      const bankReference = textAt(detail, 'Refs', 'EndToEndId') ?? textAt(entry, 'NtryRef');
      const txCount = all(entry, 'TxDtls').length;

      Object.assign(raw, {
        CdtDbtInd: indicator ?? '', Amt: child(entry, 'Amt')?.text.trim() ?? '',
        BookgDt: transactionDate, AcctSvcrRef: bankTransactionId ?? '',
        AddtlNtryInf: additional ?? '', Ustrd: unstructured ?? '',
      });

      transactions.push({
        rowNumber,
        transactionDate,
        valueDate: camtDate(child(entry, 'ValDt')),
        description,
        amountMinor,
        currency: entryCurrency,
        baseAmountMinor: null,
        balanceAfterMinor: null,
        bankReference: bankReference && bankReference !== 'NOTPROVIDED' ? bankReference : null,
        bankTransactionId,
        counterpartyName,
        counterpartyIban: partyIban(counterpartyAccount),
        transactionType: textAt(entry, 'BkTxCd', 'Domn', 'Fmly', 'SubFmlyCd')?.toLowerCase()
          ?? textAt(entry, 'BkTxCd', 'Prtry', 'Cd'),
        notes: [
          unstructured && unstructured !== description ? unstructured : null,
          txCount > 1 ? `A batch of ${txCount} payments booked as one entry.` : null,
          textAt(entry, 'RvslInd') === 'true' ? 'The bank marks this entry as a reversal.' : null,
        ].filter(Boolean).join(' ') || null,
        fingerprint: transactionFingerprint({
          bankAccountId: options.bankAccountId, transactionDate, amountMinor, currency: entryCurrency,
          description, bankReference, bankTransactionId,
        }),
        rawData: raw,
      });
    } catch (error) {
      errors.push({ rowNumber, message: error instanceof Error ? error.message : String(error), raw });
    }
  }
  if (pending > 0) {
    warnings.push(`${pending} entr${pending === 1 ? 'y is' : 'ies are'} not yet booked by the bank and ${pending === 1 ? 'was' : 'were'} not imported. They will appear on a later statement once booked.`);
  }

  return {
    transactions, errors, warnings, headers: [], rowsRead: entries.length,
    statementCurrency: currency, accountIdentifier,
    openingBalanceMinor, closingBalanceMinor, closingBalanceDate,
  };
}
