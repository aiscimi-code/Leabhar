import type { Metadata } from 'next';
import './globals.css';
import { Nav } from '@/components/Nav';
import { activeCompany } from '@/lib/queries';
import { DemoBanner } from '@/components/primitives';

export const metadata: Metadata = {
  title: 'Leabhar — Irish accounting',
  description: 'Local-first accounting and tax preparation for a small Irish company.',
};

export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
