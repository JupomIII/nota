export function relativeTime(timestamp: number | null | undefined): string {
  if (!timestamp) return 'never';
  const diff = Date.now() - timestamp;
  if (diff < 45_000) return 'just now';
  // Rounding up would print "60 min ago" and "24 h ago" just before each unit
  // switches, so each figure is floored and the unit promotes on its own boundary.
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const PENDING_LABELS: Record<string, [string, string]> = {
  notebook: ['notebook', 'notebooks'],
  folder: ['folder', 'folders'],
  page: ['page', 'pages'],
  stroke: ['stroke', 'strokes'],
  text: ['text block', 'text blocks'],
  image: ['image', 'images'],
  equation: ['equation', 'equations'],
  graph: ['graph', 'graphs'],
  table: ['table', 'tables'],
  asset: ['file', 'files'],
};

/**
 * "3 strokes · 1 page · 2 notebooks" — what is actually waiting for the server.
 * The three biggest kinds are enough to recognise the state at a glance.
 */
/** Stable order for equal counts, so the line does not shuffle between reads. */
const KIND_ORDER = ['notebook', 'folder', 'page', 'stroke', 'text', 'image', 'equation', 'graph', 'table', 'asset'];

export function describePending(counts: Record<string, number>): string {
  const rank = (kind: string) => {
    const index = KIND_ORDER.indexOf(kind);
    return index === -1 ? KIND_ORDER.length : index;
  };
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0]))
    .slice(0, 3)
    .map(([kind, count]) => {
      const [one, many] = PENDING_LABELS[kind] ?? [kind, `${kind}s`];
      return `${count} ${count === 1 ? one : many}`;
    })
    .join(' · ');
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
