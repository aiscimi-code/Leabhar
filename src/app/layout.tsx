import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import './globals.css';
import { Nav } from '@/components/Nav';
import { activeCompany } from '@/lib/queries';
import { currentUser } from '@/lib/session';
import { isCompanyMember } from '@/domain/auth/permissions';
import { getDb } from '@/db';
import { DemoBanner } from '@/components/primitives';

export const metadata: Metadata = {
  title: 'Leabhar — Irish accounting',
  description: 'Local-first accounting and tax preparation for a small Irish company.',
};

export const dynamic = 'force-dynamic';

function publicSiteHost(header: string | null): boolean {
  const host = header?.split(',')[0]?.trim().split(':')[0]?.toLowerCase() ?? '';
  return host === 'fgi.ie' || host === 'www.fgi.ie';
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const headerStore = await headers();
  // www.fgi.ie only serves the portal. The portal is also opened without the
  // installed-app navigation, including on a Vercel preview, because that
  // chrome links at routes that need the on-disk database.
  const portalOnly = headerStore.get('x-leabhar-portal') === '1';
  if (
    portalOnly
    || publicSiteHost(headerStore.get('x-forwarded-host'))
    || publicSiteHost(headerStore.get('host'))
  ) {
    return (
      <html lang="en-IE">
        <body>
          <main className="min-h-screen">{children}</main>
        </body>
      </html>
    );
  }

  // The read surface verifies the session against the database, not just the
  // cookie (issue #482). Middleware can only check that the cookie exists —
  // it runs on the Edge — so a removed user's stale cookie reaches this far.
  // The login page (and the portal, handled above) is marked public by the
  // middleware and renders without a session.
  if (headerStore.get('x-leabhar-public') !== '1') {
    const user = await currentUser();
    if (!user) redirect('/login');

    const active = activeCompany();
    if (active && !isCompanyMember(getDb(), user.id, active.id)) {
      return (
        <html lang="en-IE">
          <body>
            <main className="mx-auto max-w-xl px-6 py-16">
              <h1 className="text-xl font-semibold text-ink">Not a member of this company&apos;s books</h1>
              <p className="mt-3 text-sm text-ink-muted">
                You are signed in as {user.displayName || user.username}, but you are not a member
                of {active.tradingName ?? active.legalName}. Ask the book&apos;s owner to add you,
                or switch to a company you are a member of.
              </p>
            </main>
          </body>
        </html>
      );
    }
  }

  let company: ReturnType<typeof activeCompany>;
  try {
    company = activeCompany();
  } catch {
    company = undefined;
  }

  return (
    <html lang="en-IE">
      <body>
        {company?.isDemo && <DemoBanner />}
        {/* The login screen renders without the signed-in chrome (issue
            #473): a visitor who is not yet a user should not see the book's
            navigation. The middleware marks the public paths. */}
        {headerStore.get('x-leabhar-public') === '1' ? (
          <main className="min-h-screen">{children}</main>
        ) : (
          <div className="flex min-h-screen">
            <Nav companyName={company?.tradingName ?? company?.legalName ?? null} />
            <main className="flex-1 min-w-0">{children}</main>
          </div>
        )}
      </body>
    </html>
  );
}
