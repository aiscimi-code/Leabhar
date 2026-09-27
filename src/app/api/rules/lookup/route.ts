import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { currentUser } from '@/lib/session';
import {
  lookupTransactionRules, transactionContextFromQueryParams,
} from '@/domain/rules/transactionLookup';

export const dynamic = 'force-dynamic';

/**
 * Deterministic rule lookup over HTTP (issue #447).
 *
 * GET only, like every route under src/app/api (docs/API.md): the lookup is a
 * read. The transaction context arrives as query params and is parsed by the
 * domain (`transactionContextFromQueryParams`), so this handler decides
 * nothing itself — the same parser, evaluator and citation data the CLI's
 * `lookup` command uses produce the same answer here.
 */
export async function GET(request: Request): Promise<Response> {
  if (!(await currentUser())) return new Response('Not signed in.', { status: 401 });

  const searchParams = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = transactionContextFromQueryParams(searchParams);
  if (!parsed.ok) return new Response(parsed.error, { status: 400 });

  const company = requireCompany();
  const result = lookupTransactionRules(getDb(), {
    companyId: company.id,
    transaction: parsed.transaction,
  });
  return Response.json(result);
}
