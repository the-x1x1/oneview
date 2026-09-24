/**
 * A small, tolerant XML tag scanner for OGC GetCapabilities documents.
 *
 * The main process has no DOM, and a general XML parser is a dependency (and an attack
 * surface) this connector does not need: capabilities documents are read for a few dozen
 * element names. The scanner builds a light tree of elements with their local names,
 * attributes and text, and is forgiving where real servers are sloppy — a close tag that
 * does not match closes up to the element it names or is ignored, an unclosed document is
 * closed at the end, comments, processing instructions and a DOCTYPE with an internal
 * subset are skipped, CDATA is text. It never resolves an entity beyond the five XML ones
 * and numeric references, never fetches anything a document names, and stops at fixed
 * limits on elements and depth.
 */

export interface XmlElement {
  /** Local name, without a namespace prefix. */
  name: string;
  /** The prefix as written (`ows`, `wfs`, or empty). */
  prefix: string;
  /** Attributes by local name (`xlink:href` is `href`); namespace declarations are left out. */
  attrs: Record<string, string>;
  children: XmlElement[];
  /** The element's own text and CDATA, entity-decoded, not trimmed. */
  text: string;
}

export const MAX_XML_ELEMENTS = 200_000;
export const MAX_XML_DEPTH = 64;

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,6});/g, (whole, ref: string) => {
    if (ref.startsWith('#x')) return fromCodePoint(parseInt(ref.slice(2), 16), whole);
    if (ref.startsWith('#')) return fromCodePoint(parseInt(ref.slice(1), 10), whole);
    return NAMED_ENTITIES[ref] ?? whole;
  });
}

function fromCodePoint(n: number, fallback: string): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}

function splitName(qname: string): { prefix: string; name: string } {
  const i = qname.indexOf(':');
  return i < 0 ? { prefix: '', name: qname } : { prefix: qname.slice(0, i), name: qname.slice(i + 1) };
}

// The value is optional so that a long run of name characters is consumed once, never retried
// from each position (a start tag of 80,000 bare name characters took seven seconds before).
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g;

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR.exec(source)) !== null) {
    const qname = m[1]!;
    if (m[2] === undefined && m[3] === undefined && m[4] === undefined) continue;
    if (qname === 'xmlns' || qname.startsWith('xmlns:')) continue;
    const { name } = splitName(qname);
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** The end of a start tag: the first `>` outside a quoted attribute value. */
function tagEnd(text: string, from: number): number {
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

/** Skip a DOCTYPE, including an internal subset in square brackets. */
function doctypeEnd(text: string, from: number): number {
  const close = text.indexOf('>', from);
  if (close < 0) return text.length;
  // Look for the subset only before that `>`: searching the rest of the document for a `[`
  // on every `<!…>` made a document of them quadratic.
  const bracket = text.slice(from, close).indexOf('[');
  if (bracket >= 0) {
    const endSubset = text.indexOf(']', from + bracket);
    if (endSubset < 0) return text.length;
    const after = text.indexOf('>', endSubset);
    return after < 0 ? text.length : after + 1;
  }
  return close + 1;
}

/** Scan a document into its root element, or say why it is not one. */
export function scanXml(input: string): { root: XmlElement } | { malformed: string } {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const start = text.search(/\S/);
  if (start < 0) return { malformed: 'the response is empty' };
  if (text[start] !== '<') return { malformed: 'the response is not XML' };
  const top: XmlElement = { name: '#document', prefix: '', attrs: {}, children: [], text: '' };
  const stack: Array<{ el: XmlElement; qname: string }> = [{ el: top, qname: '' }];
  let count = 0;
  let i = start;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const current = stack[stack.length - 1]!.el;
    if (lt < 0) {
      current.text += decodeEntities(text.slice(i));
      break;
    }
    if (lt > i) current.text += decodeEntities(text.slice(i, lt));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      current.text += text.slice(lt + 9, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      i = doctypeEnd(text, lt + 2);
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    const end = tagEnd(text, lt + 1);
    if (end < 0) break;
    const body = text.slice(lt + 1, end);
    i = end + 1;
    if (body.startsWith('/')) {
      const qname = body.slice(1).trim();
      // Close up to the element this names; a stray close tag closes nothing.
      for (let k = stack.length - 1; k > 0; k--)
        if (stack[k]!.qname === qname) {
          stack.length = k;
          break;
        }
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameEnd = inner.search(/[\s/]|$/);
    const qname = inner.slice(0, nameEnd);
    if (!qname || !/^[A-Za-z_]/.test(qname)) continue;
    if (++count > MAX_XML_ELEMENTS) return { malformed: `more than ${MAX_XML_ELEMENTS} elements` };
    const { prefix, name } = splitName(qname);
    const el: XmlElement = { name, prefix, attrs: parseAttrs(inner.slice(nameEnd)), children: [], text: '' };
    current.children.push(el);
    if (!selfClosing) {
      if (stack.length > MAX_XML_DEPTH) return { malformed: `nested deeper than ${MAX_XML_DEPTH} elements` };
      stack.push({ el, qname });
    }
  }
  const root = top.children[0];
  return root ? { root } : { malformed: 'the response has no XML element' };
}

// ── reading the tree ─────────────────────────────────────────────────────────

/** Direct children with this local name (case-sensitive, as XML is). */
export function childrenNamed(el: XmlElement | undefined, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.name === name) : [];
}

export function child(el: XmlElement | undefined, name: string): XmlElement | undefined {
  return el?.children.find((c) => c.name === name);
}

/** A chain of direct children: `at(root, 'Capability', 'Request', 'GetMap')`. */
export function at(el: XmlElement | undefined, ...names: string[]): XmlElement | undefined {
  let cur = el;
  for (const n of names) cur = child(cur, n);
  return cur;
}

/** Every descendant with this local name, in document order. */
export function descendants(el: XmlElement | undefined, name: string, out: XmlElement[] = []): XmlElement[] {
  if (!el) return out;
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

/** An element's trimmed text, or undefined when it is absent or blank. */
export function textOf(el: XmlElement | undefined): string | undefined {
  const t = el?.text.trim();
  return t ? t : undefined;
}

export function childText(el: XmlElement | undefined, name: string): string | undefined {
  return textOf(child(el, name));
}

export function numberOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : undefined;
}

/** The first `href` on this element or below it (OnlineResource, Get, LegendURL…). */
export function hrefIn(el: XmlElement | undefined): string | undefined {
  if (!el) return undefined;
  const own = el.attrs['href']?.trim();
  if (own) return own;
  for (const c of el.children) {
    const h = hrefIn(c);
    if (h) return h;
  }
  return undefined;
}

const EXCEPTION_ROOTS = new Set(['ServiceExceptionReport', 'ServiceException', 'ExceptionReport', 'Exception']);

/** The text of an OGC exception document (WMS ServiceException, OWS ExceptionReport), if this is one. */
export function exceptionMessage(root: XmlElement): string | undefined {
  if (!EXCEPTION_ROOTS.has(root.name)) return undefined;
  const parts: string[] = [];
  const collect = (el: XmlElement) => {
    const code = el.attrs['exceptionCode'] ?? el.attrs['code'];
    const t = el.text.replace(/\s+/g, ' ').trim();
    if (t) parts.push(code ? `${code}: ${t}` : t);
    else if (code && el.children.length === 0) parts.push(code);
    for (const c of el.children) collect(c);
  };
  collect(root);
  const msg = parts.join('; ').slice(0, 300);
  return msg || root.name;
}
