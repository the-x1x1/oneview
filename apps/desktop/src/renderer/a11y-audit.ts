/**
 * A static accessibility audit of rendered markup (roadmap 1.0: accessibility audit). It reads
 * the HTML React renders on the server and reports what a screen reader could not name:
 *
 *  - a button, or anything with role button/switch/tab/radio/checkbox/menuitem/slider, with no
 *    text, `aria-label`, `aria-labelledby` or `title`;
 *  - an `<input>`, `<select>` or `<textarea>` (not hidden) with no `aria-label`,
 *    `aria-labelledby`, `title`, enclosing `<label>`, or `<label for>` naming its id;
 *  - an `<img>` without `alt`, and an `<svg role="img">` without a label.
 *
 * It is a lint over markup, not a screen-reader test: what it passes can still read badly.
 */
export interface A11yFinding {
  rule: 'name' | 'label' | 'alt';
  element: string;
}

const NAMED_ROLES = /\brole="(button|switch|tab|radio|checkbox|menuitem|slider|link)"/;
const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'area', 'col', 'wbr']);

interface Node {
  tag: string;
  attrs: string;
  start: number;
  end: number;
  inner: string;
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : undefined;
}

function text(html: string): string {
  return html
    .replace(/<[^>]+aria-hidden="true"[^>]*>[\s\S]*?<\/[a-z]+>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/g, 'x')
    .trim();
}

/** Elements with their inner HTML, by a stack walk over the tags (React's output is well formed). */
function elements(html: string): Node[] {
  const out: Node[] = [];
  const stack: Array<{ tag: string; attrs: string; start: number; contentStart: number }> = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const [whole, closing, rawTag, attrs, selfClosing] = m;
    const tag = rawTag!.toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.tag !== tag) continue;
        const open = stack.splice(i)[0]!;
        out.push({
          tag,
          attrs: open.attrs,
          start: open.start,
          end: m.index + whole.length,
          inner: html.slice(open.contentStart, m.index),
        });
        break;
      }
    } else if (selfClosing || VOID.has(tag)) {
      out.push({ tag, attrs: attrs ?? '', start: m.index, end: m.index + whole.length, inner: '' });
    } else {
      stack.push({ tag, attrs: attrs ?? '', start: m.index, contentStart: m.index + whole.length });
    }
  }
  return out;
}

function hasName(n: Node): boolean {
  return Boolean(
    attr(n.attrs, 'aria-label')?.trim() ||
    attr(n.attrs, 'aria-labelledby')?.trim() ||
    attr(n.attrs, 'title')?.trim() ||
    text(n.inner),
  );
}

function snippet(html: string, n: Node): string {
  return html.slice(n.start, Math.min(n.end, n.start + 160));
}

export function auditMarkup(html: string): A11yFinding[] {
  const all = elements(html);
  const labelFor = new Set(
    all
      .filter((n) => n.tag === 'label')
      .map((n) => attr(n.attrs, 'for'))
      .filter(Boolean),
  );
  const labels = all.filter((n) => n.tag === 'label');
  const findings: A11yFinding[] = [];
  for (const n of all) {
    if (/\baria-hidden="true"/.test(n.attrs)) continue;
    if (n.tag === 'button' || NAMED_ROLES.test(n.attrs)) {
      if (!hasName(n)) findings.push({ rule: 'name', element: snippet(html, n) });
      continue;
    }
    if (n.tag === 'input' || n.tag === 'select' || n.tag === 'textarea') {
      const type = attr(n.attrs, 'type');
      if (type === 'hidden') continue;
      const id = attr(n.attrs, 'id');
      const named =
        attr(n.attrs, 'aria-label')?.trim() ||
        attr(n.attrs, 'aria-labelledby')?.trim() ||
        attr(n.attrs, 'title')?.trim() ||
        (id && labelFor.has(id)) ||
        labels.some((l) => l.start < n.start && l.end > n.end && text(l.inner));
      if (!named) findings.push({ rule: 'label', element: snippet(html, n) });
      continue;
    }
    if (n.tag === 'img' && attr(n.attrs, 'alt') === undefined)
      findings.push({ rule: 'alt', element: snippet(html, n) });
    if (n.tag === 'svg' && /\brole="img"/.test(n.attrs) && !hasName({ ...n, inner: '' }))
      findings.push({ rule: 'alt', element: snippet(html, n) });
  }
  return findings;
}
