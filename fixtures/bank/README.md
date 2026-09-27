# Sample bank statements

Three small statements covering January–April 2025 for one AIB current
account, in the three formats Leabhar imports. They exist so the import flow
(README §13, §14) can be walked end to end from files a person can actually
upload, without hand-writing a statement first.

| File | Format | Period |
| --- | --- | --- |
| `january-february.csv` | CSV | 3 Jan – 28 Feb 2025 |
| `march.ofx` | OFX 1.x (SGML) | 1 – 31 Mar 2025 |
| `april-camt.053.xml` | CAMT.053 (ISO 20022) | 28 Mar – 30 Apr 2025 |

## The known duplicate overlap

Real bank downloads overlap: this CAMT file's opening balance is dated 28
March, and it repeats the OFX statement's 28 March `AIB-0004` entry
(Supervalu Newbridge, −€80.00) — the same bank transaction id, so importing
it after `march.ofx` reports that one entry as a duplicate and imports the
rest.

Importing any file a second time is refused outright as the same file
(imported once already), which is the other duplicate defence.

## Importing them

Import → Bank data, with the account's currency set to EUR.

- The CSV needs the column mapping `Date → transaction_date`,
  `Description → description`, `Amount → amount` (the importer proposes it
  automatically from the header row).
- The OFX and CAMT files carry their own transaction ids and dates; no
  mapping is needed.
