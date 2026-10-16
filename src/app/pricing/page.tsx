import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { PricingPage } from '@/components/PricingPage';

export const dynamic = 'force-dynamic';

function isPublicHost(host: string | null): boolean {
  const h = host?.split(',')[0]?.trim().split(':')[0]?.toLowerCase() ?? '';
  return h === 'fgi.ie' || h === 'www.fgi.ie';
}

/**
 * Pricing page for the public site (fgi.ie / www.fgi.ie).
 *
 * The public host has no on-disk database, so the page is a pure server
 * component with no database access. On any other host (a local install)
 * the visitor is sent to the portal instead.
 */
export default async function PricingRoute() {
  const h = await headers();
  const host = h.get('x-forwarded-host') || h.get('host');
  if (!isPublicHost(host)) redirect('/portal');

  return <PricingPage />;
}
