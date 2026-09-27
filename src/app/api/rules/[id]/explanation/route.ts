import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { requireActor } from '@/lib/session';
import { explainRule } from '@/domain/rules/ruleInfo';

export const dynamic = 'force-dynamic';

/**
 * A statutory rule's explanation over HTTP (issue #448): what it says, when
 * it applies, what it excepts, what it effects, and where it comes from. The
 * explanation is assembled by the domain (`explainRule`), so this route and
 * the UI cannot disagree about a rule.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // A member of this company with read access, like every other read route
  // (#372): being signed in is not enough on its own.
  try {
    await requireActor('books.read');
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Not allowed.', { status: 403 });
  }
  const { id } = await params;
  const company = requireCompany();
  const explanation = explainRule(getDb(), { companyId: company.id, ruleId: id });
  if (!explanation) return new Response('No such rule for this company.', { status: 404 });
  return Response.json(explanation);
}
