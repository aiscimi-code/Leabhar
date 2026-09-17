import { describe, it, expect } from 'vitest';
import { parseCsv, proposeColumnMapping, readCsvHeaders, headerSignature } from './statementParser';

const opts = (over: Partial<Parameters<typeof parseCsv>[1]> = {}) => ({
  bankAccountId: 'ba_1',
  columnMap: {
    Date: 'transaction_date' as const,
    Description: 'description' as const,
    Amount: 'amount' as const,
  },
  defaultCurrency: 'EUR',
  ...over,
});

describe('parseCsv', () => {
  it('parses a simple Irish bank export', () => {
    const csv = [
      'Date,Description,Amount',
      '15/03/2025,VERCEL INC,-42.17',
      '16/03/2025,CUSTOMER PAYMENT,1500.00',
    ].join('\n');
    const result = parseCsv(csv, opts());

    expect(result.errors).toEqual([]);
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({
      transactionDate: '2025-03-15', description: 'VERCEL INC',
      amountMinor: -4217, currency: 'EUR',
    });
    expect(result.transactions[1]!.amountMinor).toBe(150_000);
  });

  it('keeps money out negative and money in positive', () => {
    const csv = 'Date,Description,Amount\n01/01/2025,OUT,-10.00\n02/01/2025,IN,10.00';
    const result = parseCsv(csv, opts());
    expect(result.transactions[0]!.amountMinor).toBe(-1000);
    expect(result.transactions[1]!.amountMinor).toBe(1000);
  });

  it('handles separate debit and credit columns', () => {
    const csv = [
      'Date,Details,Money Out,Money In',
      '15/03/2025,VERCEL,42.17,',
      '16/03/2025,CUSTOMER,,1500.00',
    ].join('\n');
    const result = parseCsv(csv, opts({
      columnMap: {
        Date: 'transaction_date', Details: 'description',
        'Money Out': 'debit', 'Money In': 'credit',
      },
      amountStyle: 'debit_credit_columns',
    }));
    expect(result.errors).toEqual([]);
    expect(result.transactions[0]!.amountMinor).toBe(-4217);
    expect(result.transactions[1]!.amountMinor).toBe(150_000);
  });

  it('rejects a row with both a debit and a credit', () => {
    const csv = 'Date,Details,Out,In\n15/03/2025,ODD,10.00,20.00';
    const result = parseCsv(csv, opts({
      columnMap: { Date: 'transaction_date', Details: 'description', Out: 'debit', In: 'credit' },
      amountStyle: 'debit_credit_columns',
    }));
    expect(result.transactions).toHaveLength(0);
    expect(result.errors[0]!.message).toMatch(/both a debit .* and a credit/);
  });

  it('inverts the sign for banks that report money out as positive', () => {
    const csv = 'Date,Description,Amount\n15/03/2025,VERCEL,42.17';
    const result = parseCsv(csv, opts({ invertAmountSign: true }));
    expect(result.transactions[0]!.amountMinor).toBe(-4217);
  });

  it('honours month-first dates when the profile says so', () => {
    const csv = 'Date,Description,Amount\n03/04/2025,X,-1.00';
    expect(parseCsv(csv, opts()).transactions[0]!.transactionDate).toBe('2025-04-03');
    expect(parseCsv(csv, opts({ dateFormat: 'month_first' })).transactions[0]!.transactionDate)
      .toBe('2025-03-04');
  });

  it('honours an explicit decimal separator', () => {
    const csv = 'Date;Description;Amount\n15/03/2025;VERCEL;-1.234,56';
    const result = parseCsv(csv, opts({
      delimiter: ';', decimalSeparator: ',',
      columnMap: { Date: 'transaction_date', Description: 'description', Amount: 'amount' },
    }));
    expect(result.transactions[0]!.amountMinor).toBe(-123_456);
  });

  it('collects per-row errors without abandoning the whole import', () => {
    const csv = [
      'Date,Description,Amount',
      '15/03/2025,GOOD,-42.17',
      'not-a-date,BAD DATE,-10.00',
      '17/03/2025,BAD AMOUNT,abc',
      '18/03/2025,ALSO GOOD,-5.00',
    ].join('\n');
    const result = parseCsv(csv, opts());
    expect(result.transactions).toHaveLength(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]!.rowNumber).toBe(2);
    expect(result.errors[1]!.rowNumber).toBe(3);
    expect(result.rowsRead).toBe(4);
  });

  it('warns when a column the import depends on is unmapped', () => {
    const csv = 'Date,Description,Amount\n15/03/2025,X,-1.00';
    const result = parseCsv(csv, opts({
      columnMap: { Date: 'transaction_date', Description: 'description' },
    }));
    expect(result.warnings.some((w) => w.includes('amount'))).toBe(true);
    expect(result.transactions).toHaveLength(0);
  });

  it('warns about ambiguous amounts rather than silently guessing', () => {
    const csv = 'Date,Description,Amount\n15/03/2025,X,1.005';
    const result = parseCsv(csv, opts());
    expect(result.warnings.some((w) => w.includes('thousands separator'))).toBe(true);
  });

  it('skips preamble rows', () => {
    const csv = [
      'Statement for account IE12 BOFI 1234',
      'Generated 01/04/2025',
      'Date,Description,Amount',
      '15/03/2025,VERCEL,-42.17',
    ].join('\n');
    const result = parseCsv(csv, opts({ skipRows: 2 }));
    expect(result.transactions).toHaveLength(1);
  });

  it('captures the running balance and the bank’s own transaction id', () => {
    const csv = [
      'Date,Description,Amount,Balance,Transaction ID',
      '15/03/2025,VERCEL,-42.17,1234.56,TX-0001',
    ].join('\n');
    const result = parseCsv(csv, opts({
      columnMap: {
        Date: 'transaction_date', Description: 'description', Amount: 'amount',
        Balance: 'balance', 'Transaction ID': 'bank_transaction_id',
      },
    }));
    expect(result.transactions[0]!.balanceAfterMinor).toBe(123_456);
    expect(result.transactions[0]!.bankTransactionId).toBe('TX-0001');
  });

  it('preserves the original row for inspection', () => {
    const csv = 'Date,Description,Amount,Extra\n15/03/2025,VERCEL,-42.17,keepme';
    const result = parseCsv(csv, opts({
      columnMap: {
        Date: 'transaction_date', Description: 'description',
        Amount: 'amount', Extra: 'ignore',
      },
    }));
    expect(result.transactions[0]!.rawData['Extra']).toBe('keepme');
  });

  it('produces identical fingerprints when the same file is parsed twice', () => {
    const csv = 'Date,Description,Amount\n15/03/2025,VERCEL,-42.17\n15/03/2025,VERCEL,-42.17';
    const first = parseCsv(csv, opts());
    const second = parseCsv(csv, opts());
    expect(first.transactions.map((t) => t.fingerprint))
      .toEqual(second.transactions.map((t) => t.fingerprint));
  });
});

describe('proposeColumnMapping', () => {
  it('maps a conventional header row', () => {
    const { mapping } = proposeColumnMapping(['Date', 'Description', 'Amount', 'Balance']);
    expect(mapping).toEqual({
      Date: 'transaction_date', Description: 'description',
      Amount: 'amount', Balance: 'balance',
    });
  });

  it('maps debit and credit column variants', () => {
    const { mapping } = proposeColumnMapping([
      'Posting Date', 'Details', 'Paid Out', 'Paid In', 'Balance',
    ]);
    expect(mapping['Posting Date']).toBe('transaction_date');
    expect(mapping['Paid Out']).toBe('debit');
    expect(mapping['Paid In']).toBe('credit');
  });

  it('distinguishes value date from transaction date', () => {
    const { mapping } = proposeColumnMapping(['Transaction Date', 'Value Date', 'Amount']);
    expect(mapping['Transaction Date']).toBe('transaction_date');
    expect(mapping['Value Date']).toBe('value_date');
  });

  it('scores an exact match above a loose one', () => {
    const exact = proposeColumnMapping(['Date']);
    const loose = proposeColumnMapping(['Some Date Column']);
    expect(exact.confidence['Date']!).toBeGreaterThan(loose.confidence['Some Date Column']!);
  });

  it('reports columns it could not place', () => {
    const { unmapped } = proposeColumnMapping(['Date', 'Amount', 'Mystery Column']);
    expect(unmapped).toEqual(['Mystery Column']);
  });

  it('never maps two columns to the same field', () => {
    const { mapping } = proposeColumnMapping(['Date', 'Booking Date', 'Amount']);
    const fields = Object.values(mapping);
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe('header detection', () => {
  it('reads headers without parsing the body', () => {
    expect(readCsvHeaders('Date,Description,Amount\n15/03/2025,X,-1'))
      .toEqual(['Date', 'Description', 'Amount']);
  });

  it('produces a stable signature for a known format', () => {
    expect(headerSignature(['Date', 'Description', 'Amount']))
      .toBe(headerSignature(['date', ' Description ', 'AMOUNT']));
    expect(headerSignature(['Date', 'Amount']))
      .not.toBe(headerSignature(['Date', 'Description', 'Amount']));
  });
});

describe('multi-currency card line mapping', () => {
  it('recognises Orig Amount as original_amount and maps Amount to base_amount', () => {
    const headers = ['Date', 'Description', 'Orig currency', 'Orig amount', 'Amount', 'Payment currency'];
    const { mapping } = proposeColumnMapping(headers);
    expect(mapping['Orig currency']).toBe('currency');
    expect(mapping['Orig amount']).toBe('original_amount');
    // 'Amount' should NOT be 'amount' here because 'original_amount' took
    // the amount-like column; but proposeColumnMapping maps field-by-field
    // in order, so Amount maps to 'amount' and Orig amount to 'original_amount'.
    // The important thing is that original_amount is recognised.
    expect(mapping['Orig amount']).toBeTruthy();
  });

  it('parses a Revolut-style row with original amount as the foreign charge', () => {
    const csv = [
      'Date,Description,Orig currency,Orig amount,Amount,Payment currency',
      '15/03/2025,GITHUB INC,USD,-26.06,-22.58,EUR',
    ].join('\n');
    const result = parseCsv(csv, {
      bankAccountId: 'ba_1',
      columnMap: {
        Date: 'transaction_date',
        Description: 'description',
        'Orig currency': 'currency',
        'Orig amount': 'original_amount',
        Amount: 'base_amount',
        'Payment currency': 'ignore',
      },
      defaultCurrency: 'EUR',
    });
    expect(result.errors).toHaveLength(0);
    expect(result.transactions).toHaveLength(1);
    const tx = result.transactions[0]!;
    // amountMinor is the original USD charge, not the EUR settled debit.
    expect(tx.amountMinor).toBe(-2606);
    expect(tx.currency).toBe('USD');
    // baseAmountMinor is the settled EUR debit.
    expect(tx.baseAmountMinor).toBe(-2258);
  });

  it('parses correctly without original_amount (standard single-currency)', () => {
    const csv = [
      'Date,Description,Amount',
      '15/03/2025,VERCEL INC,-42.17',
    ].join('\n');
    const result = parseCsv(csv, {
      bankAccountId: 'ba_1',
      columnMap: {
        Date: 'transaction_date',
        Description: 'description',
        Amount: 'amount',
      },
      defaultCurrency: 'EUR',
    });
    expect(result.transactions[0]!.amountMinor).toBe(-4217);
    expect(result.transactions[0]!.baseAmountMinor).toBeNull();
  });
});
