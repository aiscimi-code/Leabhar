/**
 * Explainability (README §43, §53).
 *
 * The product principle is that the application should answer, for every
 * number: "Where did this number come from?" That is structural here rather
 * than a feature bolted onto each report — a report function returns an
 * `Explained` value carrying both the figure and its derivation, and the UI
 * renders the same object expanded when the user asks why.
 *
 * Because the components are themselves `Explained` values, drilling down is
 * recursive: a profit figure explains into revenue and expenses, revenue
 * explains into accounts, an account explains into journal lines, and a journal
 * line points at the transaction, invoice and original document behind it.
 */

export interface ExplainedSource {
  entityType: 'journal_line' | 'journal_entry' | 'bank_transaction' | 'invoice'
    | 'document' | 'vat_entry' | 'account' | 'adjustment' | 'fixed_asset';
  entityId: string;
  label: string;
  amountMinor: number;
  date?: string;
}

export interface Explained {
  label: string;
  valueMinor: number;
  currency: string;
  /** How this figure was arrived at, in the user's terms. */
  method: string;
  /** The figures this one is composed of. Recursive by design. */
  components: Explained[];
  /** The records that ultimately produced the figure. */
  sources: ExplainedSource[];
  /** Anything about this figure the user should know. */
  notes: string[];
  asOf: string;
}

export function explained(params: {
  label: string;
  valueMinor: number;
  currency: string;
  method: string;
  components?: Explained[];
  sources?: ExplainedSource[];
  notes?: string[];
  asOf: string;
}): Explained {
  return {
    label: params.label,
    valueMinor: params.valueMinor,
    currency: params.currency,
    method: params.method,
    components: params.components ?? [],
    sources: params.sources ?? [],
    notes: params.notes ?? [],
    asOf: params.asOf,
  };
}

/** Sum components into a parent figure, carrying their sources upward. */
export function sumExplained(params: {
  label: string;
  currency: string;
  method: string;
  components: Explained[];
  notes?: string[];
  asOf: string;
  /** Negate each component, e.g. expenses within a profit calculation. */
  negate?: boolean;
}): Explained {
  const sign = params.negate ? -1 : 1;
  const valueMinor = params.components.reduce((sum, c) => sum + c.valueMinor * sign, 0);
  return explained({
    label: params.label,
    valueMinor,
    currency: params.currency,
    method: params.method,
    components: params.components,
    sources: params.components.flatMap((c) => c.sources),
    notes: params.notes,
    asOf: params.asOf,
  });
}

/**
 * Walk an explanation tree to its leaves.
 * Used by the UI's "show me everything behind this" action.
 */
export function flattenSources(node: Explained): ExplainedSource[] {
  if (node.components.length === 0) return node.sources;
  return node.components.flatMap(flattenSources);
}

/** Render an explanation as indented text, for exports and the accountant pack. */
export function renderExplanation(
  node: Explained,
  format: (minor: number, currency: string) => string,
  depth = 0,
): string {
  const indent = '  '.repeat(depth);
  const lines = [`${indent}${node.label}: ${format(node.valueMinor, node.currency)}`];
  if (depth === 0 && node.method) lines.push(`${indent}  (${node.method})`);
  for (const note of node.notes) lines.push(`${indent}  Note: ${note}`);
  for (const component of node.components) {
    lines.push(renderExplanation(component, format, depth + 1));
  }
  return lines.join('\n');
}
