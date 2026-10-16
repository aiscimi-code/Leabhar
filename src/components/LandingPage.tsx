import { Panel, LinkButton, Badge } from '@/components/primitives';

/**
 * Marketing landing page for the public site (fgi.ie / www.fgi.ie).
 *
 * A pure server component: no "use client", no hooks, and no database
 * access — the public host has no on-disk database, so this must never
 * import anything from @/db, @/lib/queries or @/lib/session. Two paths:
 * the portal (work on your accounts) and the MCP server (connect AI to
 * Irish tax rules).
 */
export function LandingPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 py-16">
      {/* Hero */}
      <header className="text-center mb-10">
        <h1 className="text-3xl font-semibold text-ink leading-tight mb-3">
          Irish accounting that keeps your books on your machine
        </h1>
        <p className="text-ink-muted max-w-2xl mx-auto">
          Double-entry bookkeeping, VAT, and tax preparation for Irish small
          businesses. Local-first and open source — your books are a SQLite
          file you own, and nothing leaves your machine unless you say so.
        </p>
      </header>

      {/* Two paths */}
      <div className="grid md:grid-cols-2 gap-4 items-start mb-8">
        <Panel title="Work on your accounts">
          <div className="px-4 py-3">
            <p className="text-ink-muted mb-3">
              Open your books in the browser. Free, local-first,
              zero-retention — the vault file stays on your device, encrypted
              with your own password.
            </p>
            <ul className="text-ink-muted mb-4 space-y-1 list-disc list-inside">
              <li>Start a new set of books</li>
              <li>Unlock an existing vault</li>
              <li>Import bank statements &amp; invoices</li>
            </ul>
            <LinkButton href="/portal" variant="primary">Open Portal →</LinkButton>
          </div>
        </Panel>

        <Panel title="Connect AI to Irish tax rules">
          <div className="px-4 py-3">
            <p className="text-ink-muted mb-3">
              8 tools for VAT, reverse charge, tax treatment, and evidence
              trails. Free, no auth, read-only — point any MCP client at the
              endpoint.
            </p>
            <ul className="text-ink-muted mb-3 space-y-1 list-disc list-inside font-mono text-[12px]">
              <li>search_tax_rules</li>
              <li>get_tax_rule / get_tax_source</li>
              <li>check_reverse_charge</li>
              <li>determine_tax_treatment</li>
              <li>+ 4 more tools</li>
            </ul>
            <p className="text-ink-faint font-mono text-[11px] mb-4 break-all">
              https://mcp.fgi.ie/mcp
            </p>
            <LinkButton
              href="https://github.com/aiscimi-code/Leabhar#tax-rules-mcp-server"
              variant="secondary"
            >
              View MCP docs →
            </LinkButton>
          </div>
        </Panel>
      </div>

      {/* Feature bullets */}
      <div className="grid md:grid-cols-4 gap-4 mb-10 text-center">
        <div>
          <Badge tone="positive">Local-first</Badge>
          <p className="text-ink-muted mt-2">SQLite on your machine. Nothing leaves unless you say so.</p>
        </div>
        <div>
          <Badge tone="positive">VAT rules KB</Badge>
          <p className="text-ink-muted mt-2">427 rules, each citing the Act, Schedule or Revenue guidance.</p>
        </div>
        <div>
          <Badge tone="positive">Bank import</Badge>
          <p className="text-ink-muted mt-2">CSV/Excel statements, reconciliation, duplicate detection.</p>
        </div>
        <div>
          <Badge tone="positive">Reports</Badge>
          <p className="text-ink-muted mt-2">VAT3, RTD, VIES, CT/IT computations, trial balance, P&amp;L.</p>
        </div>
      </div>

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
            href="/pricing"
            className="underline hover:text-ink-muted"
          >
            Pricing
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
