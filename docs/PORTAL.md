# The portal (issue #166)

`/portal` is a way to use Leabhar from a browser without installing anything,
for someone who does not want to run the desktop package. It is a *separate*
front door from the rest of this app: everywhere else in Leabhar assumes one
local installation, one shared database on disk, and the single-user login in
`src/domain/auth/auth.ts` guarding it (`src/middleware.ts`). The portal makes
none of those assumptions, because it is meant to be hosted somewhere public
(Vercel, in practice) where many different people's books must never mix, and
none of them may be kept on the server at all.

## The contract

- **Every request opens its own database, in memory, and throws it away
  before it responds.** `src/db/portal.ts` opens a SQLite database from
  bytes (or fresh, for a new vault), and `better-sqlite3`'s `serialize()`
  turns it back into bytes when the request is done — no temp file, no disk
  write, at any point. This is a different database from the one the rest
  of the app uses (`getDb()` / `databasePath()`): the portal never touches
  that file.
- **The only place your data persists is the file you download.** Every
  portal action returns a fresh encrypted copy of the database
  (`src/lib/portal/crypto.ts`: scrypt to derive a key from your password,
  AES-256-GCM to encrypt) as a base64 blob the page turns into a download.
  Next time, you upload that same file back in and give the same password.
- **Losing the file, or the password, loses the data — there is nothing on
  the server to fall back on.** No account, no "forgot password" flow: the
  password is not stored anywhere, only used to derive a key for that one
  request. This is the trade a zero-retention design makes, and the UI says
  so plainly rather than implying support could ever recover it.
- **The password does cross the network for the length of one request.**
  It has to: the server does the decrypting, the SQL, and the re-encrypting.
  What "we store no data" promises is that nothing is written to a
  persistent store afterwards — not that the server is blind to it in the
  moment it does the work.
- `/portal` is exempt from the single-user login middleware
  (`src/middleware.ts`): it has its own per-vault password, and there is no
  server-side account for that login to check against in the first place.

## What v1 actually does

- **Start a new set of books**: a company and one bank account
  (`createCompany` + `addBankAccount`, the same domain functions the CLI's
  `init-company`/`add-bank` use), returned as a fresh encrypted vault.
- **Resume**: upload the vault + password to unlock it, optionally with one
  bank statement CSV to import (`importStatement`, with the same automatic
  column-mapping the CLI's `import` command uses) — returns the updated,
  still-encrypted vault plus a summary and a look at the most recent
  transactions.

## What it does not do yet

Everything else the CLI and the desktop app already do is still only
reachable there, not from `/portal`:

- Invoice/bill intake from PDFs or images, and the extraction pipeline
  behind it (`src/domain/extraction/`) — a hosted, zero-retention version of
  OCR/PDF text extraction needs its own design pass (does it run in the same
  ephemeral request, and does that still hold the "nothing persists"
  promise for whatever library does the extraction?).
- Classification, matching, reconciliation, VAT returns, reports — anything
  past "get a statement imported" is unwired. The ephemeral database/action
  pattern this issue establishes (`db/portal.ts`, `app/portal/actions.ts`)
  is meant to make adding these mostly a matter of calling the existing
  domain function from a new portal action, not new architecture.
- More than one bank account per vault (the UI assumes exactly one).
- XLSX statements (CSV only for now — `import-invoices`, multiple accounts,
  and XLSX are all straightforward extensions of the same action, just not
  built yet).
