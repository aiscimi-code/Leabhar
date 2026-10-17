import { Panel, LinkButton, Badge } from '@/components/primitives';

/**
 * Pricing page for the public site (fgi.ie / www.fgi.ie).
 *
 * A pure server component: no "use client", no hooks, and no database
 * access — the public host has no on-disk database, so this must never
 * import anything from @/db, @/lib/queries, @/lib/session or @/domain/*.
 */

function TierCard({ name, price, period, bullets, highlighted, children }: {
  name: string; price: string; period: string; bullets: string[];
  highlighted?: boolean; children: React.ReactNode;
}) {
  return (
    <div
      className={`relative bg-surface border rounded p-4 flex flex-col ${
        highlighted ? 'border-accent' : 'border-line'
      }`}
    >
      {highlighted && (
        <div className="absolute -top-2.5 left-4">
          <Badge tone="accent">Most popular</Badge>
        </div>
      )}
      <h3 className="font-semibold text-ink">{name}</h3>
      <div className="mt-1 mb-1">
        <span className="text-2xl font-semibold text-ink">{price}</span>{' '}
        <span className="text-ink-muted text-[12px]">{period}</span>
      </div>
      <ul className="text-ink-muted space-y-1 list-disc list-inside mb-4 flex-1">
        {bullets.map((bullet) => (
          <li key={bullet}>{bullet}</li>
        ))}
      </ul>
      {children}
    </div>
  );
}

export function PricingPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-16">
      {/* Header */}
      <header className="text-center mb-10">
        <h1 className="text-3xl font-semibold text-ink leading-tight mb-3">
          Pricing
        </h1>
        <p className="text-ink-muted max-w-2xl mx-auto">
          Free and open source for personal use. Paid tiers for businesses
          and AI agents.
        </p>
      </header>

      {/* Section 1 — Use Leabhar (free, AGPL-3.0) */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-ink mb-3">Use Leabhar</h2>
        <Panel
          title="Free — AGPL-3.0"
          actions={<Badge tone="positive">Free forever</Badge>}
        >
          <div className="px-4 py-3">
            <ul className="text-ink-muted mb-4 space-y-1 list-disc list-inside">
              <li>Desktop app (local SQLite, full features)</li>
              <li>Browser portal (zero-retention, encrypted vault)</li>
              <li>CLI (terminal automation)</li>
              <li>MCP server (100 free calls/month)</li>
            </ul>
            <div className="flex gap-2">
              <LinkButton href="/portal" variant="primary">Open Portal →</LinkButton>
              <LinkButton
                href="https://github.com/aiscimi-code/Leabhar"
                variant="secondary"
              >
                View on GitHub →
              </LinkButton>
            </div>
          </div>
        </Panel>
      </section>

      {/* Section 2 — MCP Server tiers */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-ink mb-3">MCP Server tiers</h2>
        <p className="text-ink-muted mb-4">
          Connect AI agents to the Irish tax rules knowledge base at{' '}
          <span className="font-mono text-[12px]">https://mcp.fgi.ie/mcp</span>.
          The free tier needs no signup; paid tiers add an API key and higher
          limits.
        </p>
        <div className="grid md:grid-cols-3 gap-4 items-stretch">
          <TierCard
            name="Free"
            price="€0"
            period="forever"
            bullets={[
              'All 8 tax tools',
              'No signup required',
              'Rate-limited by IP',
            ]}
          >
            <div className="text-ink-muted text-[12px] mb-3">100 calls/month</div>
            <LinkButton
              href="https://mcp.fgi.ie/mcp"
              variant="secondary"
            >
              Try it →
            </LinkButton>
          </TierCard>

          <TierCard
            name="Pro"
            price="€9"
            period="per month"
            bullets={[
              'All 8 tax tools',
              'API key auth',
              'Usage dashboard',
              'Email support',
            ]}
          >
            <div className="text-ink-muted text-[12px] mb-3">10,000 calls/month</div>
            {/* TODO: Replace with real Stripe Payment Link */}
            <LinkButton
              href="https://buy.stripe.com/PLACEHOLDER_PRO"
              variant="primary"
            >
              Subscribe →
            </LinkButton>
          </TierCard>

          <TierCard
            name="Business"
            price="€29"
            period="per month"
            highlighted
            bullets={[
              'All 8 tax tools',
              'API key auth',
              'Usage analytics',
              'Priority support',
              '99.9% SLA',
            ]}
          >
            <div className="text-ink-muted text-[12px] mb-3">100,000 calls/month</div>
            {/* TODO: Replace with real Stripe Payment Link */}
            <LinkButton
              href="https://buy.stripe.com/PLACEHOLDER_BUSINESS"
              variant="primary"
            >
              Subscribe →
            </LinkButton>
          </TierCard>
        </div>
        <p className="text-ink-muted mt-4">
          <strong className="text-ink">Enterprise:</strong> Custom pricing for
          AI agent platforms. Unlimited calls, dedicated instance, dedicated
          support. Contact{' '}
          <a href="mailto:aiscimi@gmail.com" className="underline hover:text-ink">
            aiscimi@gmail.com
          </a>
          .
        </p>
        <p className="text-ink-faint text-[12px] mt-2">
          Also available: a one-time rules data export (full JSON/CSV export of
          all rules with citations) for €200 —{' '}
          <a href="mailto:aiscimi@gmail.com" className="underline hover:text-ink-muted">
            contact us
          </a>
          .
        </p>
      </section>

      {/* Section 3 — Commercial license (negotiated) */}
      <section className="mb-8">
        <h2 className="text-lg font-semibold text-ink mb-3">Commercial license</h2>
        <Panel title="Commercial License">
          <div className="px-4 py-3">
            <p className="text-ink-muted mb-4">
              Leabhar is AGPL-3.0. If you want to embed it in a closed-source
              product, run a modified version as a hosted service, or need
              indemnification — we negotiate a commercial license per case.
            </p>
            <LinkButton href="mailto:aiscimi@gmail.com" variant="secondary">
              Contact us →
            </LinkButton>
          </div>
        </Panel>
      </section>

      {/* Section 4 — Sponsor the project */}
      <section className="mb-10">
        <h2 className="text-lg font-semibold text-ink mb-3">Sponsor the project</h2>
        <Panel title="GitHub Sponsors">
          <div className="px-4 py-3">
            <p className="text-ink-muted mb-3">
              Support Leabhar&apos;s development on GitHub Sponsors.
            </p>
            <ul className="text-ink-muted mb-4 space-y-1 list-disc list-inside">
              <li>€5/mo — Supporter</li>
              <li>€25/mo — Bronze</li>
              <li>€100/mo — Silver</li>
              <li>€500/mo — Gold</li>
            </ul>
            <LinkButton
              href="https://github.com/sponsors/aiscimi-code"
              variant="secondary"
            >
              Become a sponsor →
            </LinkButton>
          </div>
        </Panel>
      </section>

      {/* Footer */}
      <footer className="text-center text-ink-faint border-t border-line pt-6">
        <p>
          <a
            href="https://github.com/aiscimi-code/Leabhar"
            className="underline hover:text-ink-muted"
          >
            GitHub
          </a>
          {' · '}
          <a
            href="https://github.com/aiscimi-code/Leabhar/blob/main/COMMERCIAL.md"
            className="underline hover:text-ink-muted"
          >
            Commercial license
          </a>
          {' · '}
          <a
            href="https://github.com/aiscimi-code/Leabhar/blob/main/LICENSE"
            className="underline hover:text-ink-muted"
          >
            AGPL-3.0
          </a>
        </p>
        <p className="mt-2">© 2026 Intleacht Research Limited</p>
      </footer>
    </div>
  );
}
