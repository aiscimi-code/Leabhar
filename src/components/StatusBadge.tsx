import { Badge } from './primitives';
import { label } from '@/lib/format';

/** Lifecycle status of a bank transaction, coloured by how settled it is. */
export function StatusBadge({ status }: { status: string }) {
  const tones: Record<string, Parameters<typeof Badge>[0]['tone']> = {
    unclassified: 'caution',
    suggested: 'accent',
    classified: 'accent',
    matched: 'accent',
    posted: 'positive',
    reconciled: 'positive',
    ignored: 'neutral',
    duplicate: 'negative',
  };
  return <Badge tone={tones[status] ?? 'neutral'}>{label(status)}</Badge>;
}
