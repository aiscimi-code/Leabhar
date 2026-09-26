# API conventions

How the two HTTP surfaces of the app are shaped: **server actions** (the write
surface) and **API routes** (the read surface). Written down in issue #296;
the code below is the reference implementation, and a new route or action that
disagrees with this page is a bug in the route, not in this page.

## The one rule that shapes everything

Mutations never go over HTTP request handlers. They go through `'use server'`
actions (`src/app/actions.ts` and the `*-actions.ts` files), which call the
domain layer and return an `ActionResult`:

```ts
export type ActionResult =
  | { ok: true; message: string; warnings?: string[] }
  | { ok: false; error: string };
```

`src/app/api/**` is therefore **read-only**: it serves files, exports, assets
and a health check. There is no POST/PUT/DELETE route handler anywhere, and
adding one is a design smell — the invariant (AGENTS.md: a posting path either
completes or writes nothing) is enforced in the domain and action layers,
which route handlers would bypass.

## Server actions (`src/app/actions.ts`, `src/app/*-actions.ts`)

1. `'use server'` at the top of the file. Actions are exported functions
   taking a `FormData` (form-driven) or plain arguments.
2. The action **delegates to the domain**. It never writes to the database
   directly; it parses form values and calls a `src/domain/` function.
3. Validate what a form can get wrong *before* calling the domain, and return
   `{ ok: false, error: '…' }` with an instruction, not a code
   (`'Choose both an account and a VAT treatment.'`).
4. Wrap the domain call in `try/catch` and convert a thrown error with
   `fail()` into `{ ok: false, error }`. An action never throws to the client.
5. `revalidatePath` after a successful mutation so the screen reflects the
   books.
6. Record the actor with `actorName()` (`src/lib/session.ts`) wherever a
   decision is audited or attributed.
7. An action that posts more than one thing is the domain's job, not the
   action's: the action calls a domain function that uses `atomically()`.

## API routes (`src/app/api/**/route.ts`)

1. `export const dynamic = 'force-dynamic';` in every route. Accounting data
   must never be served from a build-time or stale cache.
2. GET only (see above). The handler signature is
   `GET(request: Request, { params }: { params: Promise<{ … }> })` — params are
   a Promise in Next.js 15+; `await` them.
3. Authentication: `await currentUser()` first; return
   `new Response('Not signed in.', { status: 401 })` when absent. Middleware
   already redirects page navigations, but a route must not rely on it — a
   fetch from the same origin does not pass through the page redirect.
4. Company scoping: `requireCompany()` (`src/lib/queries.ts`) throws when no
   company is set up; catch is unnecessary because the setup screens are the
   only state in which it can throw. Every query against a company table
   includes `eq(table.companyId, company.id)` even though ADR-0001 makes one
   book per install — the scope is defense in depth and the naming is
   load-bearing.
5. Errors are plain, small and honest:
   - `401` not signed in; `404` not found or deliberately not revealed;
   - `404` (not 500) when a stored file is missing on disk — the record is
     evidence even when the file is gone;
   - a body that says what a human should do next
     (`'The stored file is missing.'`), never a stack trace.
6. Serving stored documents requires the sandboxing headers from
   `src/app/api/documents/[id]/file/route.ts`: `X-Content-Type-Options:
   nosniff`, a sandboxing `Content-Security-Policy`, and a path check that
   the resolved file stays under `storageRoot()`.
7. `src/app/api/health/route.ts` is the exception to everything: it touches
   no database, imports nothing heavy, and must never fail for a reason
   other than "the server isn't listening". The launcher polls it.

## Exports (`src/app/api/export/**`)

Exports are a read surface with one extra rule: **no cell is ever a formula**
and no figure is recomputed. A spreadsheet that recalculates could disagree
with the books, so every cell is a literal value taken from the domain layer
(`src/lib/exports.ts` builds the workbook; the domain supplies the numbers).
Money is formatted once through `amountFor()`; a JSON response that carries
money carries it as an integer minor-unit count or a formatted string, never
a float.

## Names and layout

- Route directories are kebab-case nouns (`/api/export/year-end`);
  dynamic segments are the entity id (`[id]`).
- Server actions are named `verbNounAction`
  (`classifyTransactionAction`, `settleInvoiceByDirectorAction`).
- Dates in query strings are ISO `YYYY-MM-DD`, parsed with
  `asIsoDate()` (`src/domain/dates.ts`); there is no other date format on
  any boundary.
