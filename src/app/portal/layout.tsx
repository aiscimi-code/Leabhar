"use client";

import { PortalShell } from "@/browser/ui/shell";

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <PortalShell>{children}</PortalShell>;
}
