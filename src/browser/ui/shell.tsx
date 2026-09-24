"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { Gate } from "@/browser/ui/gate";
import { Button, DemoBanner } from "@/browser/ui/primitives";
import { useSession } from "@/browser/vault/session";

const SECTIONS: Array<{ heading: string; items: Array<{ to: string; label: string }> }> = [
  {
    heading: "Daily",
    items: [
      { to: "/portal", label: "Dashboard" },
      { to: "/portal/review", label: "Review queue" },
      { to: "/portal/transactions", label: "Transactions" },
      { to: "/portal/documents", label: "Documents" },
      { to: "/portal/import", label: "Import" },
      { to: "/portal/reconcile", label: "Reconcile" },
    ],
  },
  { heading: "VAT", items: [{ to: "/portal/vat", label: "VAT worksheet" }] },
  { heading: "Reports", items: [{ to: "/portal/reports", label: "Cash book" }] },
  {
    heading: "Setup",
    items: [
      { to: "/portal/accounts", label: "Bank accounts" },
      { to: "/portal/export", label: "Export and lock" },
    ],
  },
];

export function PortalShell({ children }: { children: React.ReactNode }) {
  const books = useSession((state) => state.books);
  const busy = useSession((state) => state.busy);
  const error = useSession((state) => state.error);
  const dismissError = useSession((state) => state.dismissError);
  const backupStale = useSession((state) => state.backupStale);
  const storageWarning = useSession((state) => state.storageWarning);
  const hydrate = useSession((state) => state.hydrate);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!backupStale) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [backupStale]);

  if (!books) return <Gate />;

  const waiting = books.transactions.filter(
    (txn) => txn.provenance === "imported" || txn.provenance === "system_rule",
  ).length;

  return (
    <div className="md:flex md:min-h-screen">
      <nav className="md:w-52 md:shrink-0 bg-surface border-b md:border-b-0 md:border-r border-line no-print">
        <div className="px-4 py-3 border-b border-line">
          <Link href="/portal" className="block">
            <div className="font-semibold text-ink text-md leading-tight">Leabhar</div>
            <div className="text-xs text-ink-faint mt-0.5 truncate">{books.company.legalName}</div>
          </Link>
        </div>
        <div className="px-3 py-2 md:hidden">
          <label className="text-xs uppercase tracking-wide font-semibold text-ink-faint" htmlFor="section-jump">
            Section
          </label>
          <select
            id="section-jump"
            className="mt-1 w-full border border-line-strong rounded px-2 min-h-11 bg-surface text-ink"
            value={pathname}
            onChange={(event) => {
              router.push(event.target.value);
            }}
          >
            {SECTIONS.flatMap((section) =>
              section.items.map((item) => (
                <option key={item.to} value={item.to}>
                  {item.label}
                  {item.to === "/portal/review" && waiting ? ` (${waiting})` : ""}
                </option>
              )),
            )}
          </select>
        </div>
        <div className="hidden md:block py-2">
          {SECTIONS.map((section) => (
            <div key={section.heading} className="mb-3">
              <div className="px-4 py-1 text-xs uppercase tracking-wider font-semibold text-ink-faint">
                {section.heading}
              </div>
              {section.items.map((item) => {
                const active = item.to === "/portal" ? pathname === "/portal" : pathname.startsWith(item.to);
                return (
                  <Link
                    key={item.to}
                    href={item.to}
                    className={`flex items-center justify-between px-4 py-1.5 text-sm border-l-2 ${
                      active
                        ? "border-accent bg-accent-soft text-accent font-medium"
                        : "border-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink"
                    }`}
                  >
                    <span>{item.label}</span>
                    {item.to === "/portal/review" && waiting > 0 && (
                      <span className="text-xs num !text-inherit">{waiting}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
        <div className="hidden md:block px-4 py-3 border-t border-line text-xs text-ink-faint leading-snug">
          A preparation tool. It does not file with Revenue and it does not tell you that you are compliant.
        </div>
      </nav>
      <main className="flex-1 min-w-0">
        {books.company.isDemo && <DemoBanner />}
        {backupStale && (
          <div className="bg-caution-soft border-b border-caution/30 px-4 py-1.5 text-sm text-caution no-print">
            Changes since your last download are encrypted in this browser only. Download the vault from Export
            and lock before you rely on another machine.
          </div>
        )}
        {storageWarning && (
          <div className="bg-negative-soft border-b border-negative/30 px-4 py-1.5 text-sm text-negative">
            {storageWarning}
          </div>
        )}
        {busy && <div className="px-4 py-1.5 text-sm text-ink-muted border-b border-line bg-surface">{busy}</div>}
        {error && (
          <div className="px-4 py-2 text-sm text-negative bg-negative-soft border-b border-negative/30 flex items-start justify-between gap-3">
            <p>{error}</p>
            <Button variant="ghost" onClick={dismissError}>
              Dismiss
            </Button>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
