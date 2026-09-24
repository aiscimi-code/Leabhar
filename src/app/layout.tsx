import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';
import { Nav } from '@/components/Nav';
import { activeCompany } from '@/lib/queries';
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
        <div className="flex min-h-screen">
          <Nav companyName={company?.tradingName ?? company?.legalName ?? null} />
          <main className="flex-1 min-w-0">{children}</main>
        </div>
      </body>
    </html>
  );
}
