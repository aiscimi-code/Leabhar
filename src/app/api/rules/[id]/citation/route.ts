import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { requireActor } from '@/lib/session';
import { ruleCitation } from '@/domain/rules/ruleInfo';

export const dynamic = 'force-dynamic';

/**
 * A statutory rule's citation over HTTP (issue #449): which provision of
 * which document the rule rests on, and where the authoritative text lives.
 * The provision id and the source's SHA-256 are included, so a caller can
 * re-check the quoted text against the source rather than trust this
 * response (AGENTS.md #5, #8).
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
  const citation = ruleCitation(getDb(), { companyId: company.id, ruleId: id });
  if (!citation) return new Response('No such rule for this company.', { status: 404 });
  return Response.json(citation);
}
