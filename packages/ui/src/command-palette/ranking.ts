/**
 * Deterministic ranking for the command palette and search suggestions.
 * Scores: exact title 100, prefix 80, word-prefix 70, substring 55, keyword match 45,
 * ordered-subsequence 20..40 (density-weighted). Ties break on the original order.
 */
export interface Rankable {
  id: string;
  title: string;
  keywords?: ReadonlyArray<string> | undefined;
  /** Optional category boost (e.g. 5 for "recent"). */
  boost?: number | undefined;
}

export interface Ranked<T extends Rankable> {
  item: T;
  score: number;
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();

export function scoreMatch(query: string, title: string, keywords: ReadonlyArray<string> = []): number {
  const q = norm(query);
  const t = norm(title);
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.split(/[\s/:-]+/).some((w) => w.startsWith(q))) return 70;
  if (t.includes(q)) return 55;
  for (const k of keywords) {
    const nk = norm(k);
    if (nk === q || nk.startsWith(q)) return 45;
    if (nk.includes(q)) return 40;
  }
  // ordered subsequence: all query chars appear in order; score by compactness
  let ti = 0, first = -1, last = -1;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return 0;
    if (first < 0) first = idx;
    last = idx;
    ti = idx + 1;
  }
  const span = last - first + 1;
  const density = q.length / span; // 1 = contiguous
  return 20 + Math.round(density * 20);
}

export function rank<T extends Rankable>(query: string, items: ReadonlyArray<T>, limit = 12): Array<Ranked<T>> {
  const out: Array<Ranked<T> & { order: number }> = [];
  items.forEach((item, order) => {
    const s = scoreMatch(query, item.title, item.keywords ?? []);
    if (s > 0) out.push({ item, score: s + (item.boost ?? 0), order });
  });
  out.sort((a, b) => b.score - a.score || a.order - b.order);
  return out.slice(0, limit).map(({ item, score }) => ({ item, score }));
}
