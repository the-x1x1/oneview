/**
 * A tolerant XML tag scanner for GPX and KML — no dependency, no DOM (the main process has
 * none), no entity expansion. It builds a small element tree from the text: element names
 * with their prefix dropped, attributes, child elements and the element's own text (with
 * CDATA and the five predefined entities and numeric references decoded).
 *
 * It is tolerant where real files are sloppy — an unquoted attribute, a stray end tag, an
 * element left open at the end of the file — and strict only where a guess would invent
 * data: no root element, or a tag that never closes, is malformed. A DOCTYPE and its
 * internal subset are skipped, never interpreted, so no external or recursive entity can be
 * reached (the XXE and billion-laughs families). Sizes are capped by the caller's byte limit
 * and here by element count and depth.
 */
export interface XmlElement {
  /** Local name: the prefix (`gx:`) removed. */
  name: string;
  /** The name as written, prefix included. */
  qname: string;
  /** Attributes by local name (prefixes removed; the last of a repeated name wins). */
  attrs: Record<string, string>;
  children: XmlElement[];
  /** The element's own text, CDATA included, entities decoded; not its children's. */
  text: string;
}

export interface XmlOptions {
  maxElements?: number;
  maxDepth?: number;
}

export const MAX_XML_ELEMENTS = 2_000_000;
export const MAX_XML_DEPTH = 256;

export type XmlResult = { root: XmlElement } | { malformed: string };

export function parseXml(text: string, opts: XmlOptions = {}): XmlResult {
  const maxElements = opts.maxElements ?? MAX_XML_ELEMENTS;
  const maxDepth = opts.maxDepth ?? MAX_XML_DEPTH;
  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let count = 0;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  // Whitespace between tags is layout, not content: it is dropped rather than kept on every container.
  const appendText = (t: string) => {
    const top = stack[stack.length - 1];
    if (top && /\S/.test(t)) top.text += t;
  };
  const appendCdata = (t: string) => {
    const top = stack[stack.length - 1];
    if (top) top.text += t;
  };
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      appendText(decodeEntities(text.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeEntities(text.slice(i, lt)));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) return { malformed: 'a comment never closes' };
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) return { malformed: 'a CDATA section never closes' };
      appendCdata(text.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) return { malformed: 'a processing instruction never closes' };
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      // DOCTYPE (with an optional [internal subset]) or another declaration: skipped whole.
      let j = lt + 2;
      let bracket = 0;
      for (; j < n; j++) {
        const c = text[j];
        if (c === '[') bracket++;
        else if (c === ']') bracket--;
        else if (c === '>' && bracket <= 0) break;
      }
      if (j >= n) return { malformed: 'a declaration never closes' };
      i = j + 1;
      continue;
    }
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt + 2);
      if (end < 0) return { malformed: 'an end tag never closes' };
      const qname = text.slice(lt + 2, end).trim();
      // Close up to the matching open element; an end tag that matches nothing is ignored.
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k]!.qname === qname) {
          stack.length = k;
          break;
        }
      }
      i = end + 1;
      continue;
    }
    const tag = readTag(text, lt + 1);
    if (!tag) return { malformed: `a tag at character ${lt} never closes` };
    i = tag.end;
    if (!tag.qname) continue;
    if (++count > maxElements) return { malformed: `more than ${maxElements} elements` };
    const el: XmlElement = { name: localName(tag.qname), qname: tag.qname, attrs: tag.attrs, children: [], text: '' };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (!root) root = el;
    else continue; // a second root: ignored, like text outside the root
    if (!tag.selfClosing) {
      if (stack.length >= maxDepth) return { malformed: `elements nested deeper than ${maxDepth}` };
      stack.push(el);
    }
  }
  if (!root) return { malformed: 'no root element' };
  return { root };
}

function readTag(
  text: string,
  start: number,
): { qname: string; attrs: Record<string, string>; selfClosing: boolean; end: number } | undefined {
  const n = text.length;
  let i = start;
  while (i < n && !isSpace(text.charCodeAt(i)) && text[i] !== '>' && text[i] !== '/') i++;
  const qname = text.slice(start, i);
  const attrs: Record<string, string> = {};
  for (;;) {
    while (i < n && isSpace(text.charCodeAt(i))) i++;
    if (i >= n) return undefined;
    if (text[i] === '>') return { qname, attrs, selfClosing: false, end: i + 1 };
    if (text[i] === '/' && text[i + 1] === '>') return { qname, attrs, selfClosing: true, end: i + 2 };
    if (text[i] === '/') {
      i++;
      continue;
    }
    const nameStart = i;
    while (i < n && !isSpace(text.charCodeAt(i)) && text[i] !== '=' && text[i] !== '>' && text[i] !== '/') i++;
    const name = text.slice(nameStart, i);
    while (i < n && isSpace(text.charCodeAt(i))) i++;
    let value = '';
    if (text[i] === '=') {
      i++;
      while (i < n && isSpace(text.charCodeAt(i))) i++;
      const q = text[i];
      if (q === '"' || q === "'") {
        const close = text.indexOf(q, i + 1);
        if (close < 0) return undefined;
        value = text.slice(i + 1, close);
        i = close + 1;
      } else {
        const vStart = i;
        while (i < n && !isSpace(text.charCodeAt(i)) && text[i] !== '>') i++;
        value = text.slice(vStart, i);
      }
    }
    if (name && !name.startsWith('xmlns')) attrs[localName(name)] = decodeEntities(value);
  }
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function localName(qname: string): string {
  const colon = qname.indexOf(':');
  return colon >= 0 ? qname.slice(colon + 1) : qname;
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** The predefined entities and numeric references; anything else is left as written. */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,4});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[body] ?? whole;
  });
}

// ── reading the tree ─────────────────────────────────────────────────────────

/** Direct children with this local name (case-insensitive: real files are not always careful). */
export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  const want = name.toLowerCase();
  return el.children.filter((c) => c.name.toLowerCase() === want);
}

export function child(el: XmlElement, name: string): XmlElement | undefined {
  const want = name.toLowerCase();
  return el.children.find((c) => c.name.toLowerCase() === want);
}

/** The trimmed text of a direct child, or undefined when it is absent or empty. */
export function childText(el: XmlElement, name: string): string | undefined {
  const c = child(el, name);
  if (!c) return undefined;
  const t = c.text.trim();
  return t === '' ? undefined : t;
}

/** Every descendant with this local name, in document order, not descending into matches. */
export function descendants(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  const want = name.toLowerCase();
  for (const c of el.children) {
    if (c.name.toLowerCase() === want) out.push(c);
    else descendants(c, name, out);
  }
  return out;
}

/** The encoding an XML declaration names, if any (`<?xml version="1.0" encoding="…"?>`). */
export function declaredEncoding(head: string): string | undefined {
  const m = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]{1,40})["']/.exec(head);
  return m ? m[1]!.toLowerCase() : undefined;
}
