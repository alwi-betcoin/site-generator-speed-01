// Fast drop-in for makefun-site 1.0.0: run(input) returns exactly the output tree
// makefun-site 1.0.0's build returns, byte for byte, for the same input.
// Written from the makefun-site README + reference behaviour (code wins on any
// difference); no vendor code is reused. Optimised for speed: bulk HTML escaping,
// cached slugs, a single-pass Markdown renderer, and a template renderer that
// accumulates into one array instead of building intermediate strings.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HAS_SPECIAL = /[&<>"']/;

/** `text` with & < > " and ' escaped. Scans once, copying plain runs in bulk. */
function escapeHtml(text) {
  if (!HAS_SPECIAL.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const e = ESCAPES[text[i]];
    if (e !== undefined) {
      if (start < i) out += text.slice(start, i);
      out += e;
      start = i + 1;
    }
  }
  if (start < text.length) out += text.slice(start);
  return out;
}

const SLUG_MAX = 64;

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left. */
function slugifyUncached(text) {
  let plain = text;
  // ASCII fast path: NFKD is the identity on ASCII and ASCII holds no marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

// Titles, tags and headings repeat a lot across a site; slugs are a pure
// function of the text, so memoise them (bounded, to stay small).
const slugCache = new Map();
function slugify(text) {
  let s = slugCache.get(text);
  if (s === undefined) {
    s = slugifyUncached(text);
    if (slugCache.size < 65536) slugCache.set(text, s);
  }
  return s;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The words of a body: its runs of characters other than whitespace. */
const WS = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 0x00a0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS[c] = 1;

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A source's front matter and body: { data, body }, or { error }. */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;
const isEscapable = (ch) => {
  const code = ch.charCodeAt(0);
  return code < 128 && ESCAPABLE[code] === 1;
};

function isLangChar(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
    code === 95 || code === 43 || code === 45;
}

/** Fence open: line of three backticks + optional language, spaces/tabs after. Returns the language or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Fence close: a line of three backticks, spaces/tabs after. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let hashes = 0;
  while (hashes < line.length && line.charCodeAt(hashes) === 35) hashes++;
  if (hashes === 0 || hashes > 6) return null;
  if (hashes >= line.length) return null;
  const c = line.charCodeAt(hashes);
  if (c !== 32 && c !== 9) return null;
  let start = hashes;
  while (start < line.length && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  let end = line.length;
  while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === start) return null;
  return { depth: hashes, text: line.slice(start, end) };
}

/** A thematic break: `---` or `***`, spaces/tabs after. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  for (let i = 3; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** A list marker line: bullet (`- `/`* `) or ordered (`12. `). Bullet wins over ordered. */
function listMarker(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) {
    return { ordered: false, start: 1, text: line.slice(2) };
  }
  if (c0 >= 48 && c0 <= 57) {
    let i = 0;
    while (i < 9 && i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
    if (i > 0 && i < line.length && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
      return { ordered: true, start: Number(line.slice(0, i)), text: line.slice(i + 2) };
    }
  }
  return null;
}

/** A list continuation line: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && WS[line.charCodeAt(i)] === 0;
}

/** A line's block kind, by its first character (the block dispatch below). */
const K_BLANK = 0;
const K_FENCE = 1;
const K_HEADING = 2;
const K_HR = 3;
const K_QUOTE = 4;
const K_LIST = 5;
const K_PARA = 6;

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that can start inline markup or need escaping. */
const TRIGGER = /[&<>"'`*\[\\]/g;

/** `s` rendered inline; `env.link(target)` is a link's href. A regex finds each
 * trigger in C++; the plain stretches between them are copied whole, and only
 * the triggers are handled here, one by one, left to right. (The shared
 * regex's lastIndex is set before every exec, so the recursive calls for
 * strong, emphasis and link text cannot disturb the outer scan.) */
function inline(s, env) {
  TRIGGER.lastIndex = 0;
  let m = TRIGGER.exec(s);
  if (m === null) return s;
  let out = '';
  let run = 0; // start of the pending plain run
  let i = m.index;
  for (;;) {
    const code = s.charCodeAt(i);
    if (code === 38) { // &
      out += s.slice(run, i) + '&amp;';
      i++;
      run = i;
    } else if (code === 60) { // <
      out += s.slice(run, i) + '&lt;';
      i++;
      run = i;
    } else if (code === 62) { // >
      out += s.slice(run, i) + '&gt;';
      i++;
      run = i;
    } else if (code === 34) { // "
      out += s.slice(run, i) + '&quot;';
      i++;
      run = i;
    } else if (code === 39) { // '
      out += s.slice(run, i) + '&#39;';
      i++;
      run = i;
    } else if (code === 92 && i + 1 < s.length && isEscapable(s[i + 1])) {
      // `>` is both escapable and HTML-escaped; the other escapable characters are not.
      out += s.slice(run, i) + (s[i + 1] === '>' ? '&gt;' : s[i + 1]);
      i += 2;
      run = i;
    } else if (code === 96) { // `
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += s.slice(run, i) + `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        run = i;
      } else {
        i++; // a backtick with no closer is itself, and stays in the run
      }
    } else if (code === 42) { // *
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out += s.slice(run, i) + `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
          run = i;
        } else {
          i += 2; // `**` with no closer is itself, and stays in the run
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += s.slice(run, i) + `<em>${inline(s.slice(i + 1, j), env)}</em>`;
          i = j + 1;
          run = i;
        } else {
          i++; // a `*` with no closer is itself, and stays in the run
        }
      }
    } else if (code === 91) { // [
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out += s.slice(run, i) + `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = mm + 1;
        run = i;
      } else {
        i++; // a `[` that opens no link is itself, and stays in the run
      }
    } else {
      i++; // unreachable: the regex only matches the cases above
    }
    TRIGGER.lastIndex = i;
    m = TRIGGER.exec(s);
    if (m === null) break;
    i = m.index;
  }
  if (run < s.length) out += s.slice(run);
  return out;
}

/**
 * `src` rendered in one pass: its HTML, its table of contents (level 2 and 3
 * headings: level, id and inline HTML) and its excerpt (first paragraph's HTML).
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  // The kind of lines[i], cached: a paragraph asks for the next line's kind to
  // know when it ends, and the block after it reuses that answer instead of
  // classifying the line again. pk* hold the kind's payload (heading, fence
  // language, list marker) for the same line.
  let k = -1;
  let pkHeading = null;
  let pkLang = '';
  let pkMarker = null;
  const getK = () => {
    if (k !== -1) return k;
    const line = lines[i];
    if (line.length === 0) return (k = K_BLANK);
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      for (let j = 1; j < line.length; j++) {
        const c = line.charCodeAt(j);
        if (c !== 32 && c !== 9) return (k = K_PARA);
      }
      return (k = K_BLANK);
    }
    if (c0 === 96) {
      pkLang = fenceOpen(line);
      return (k = pkLang !== null ? K_FENCE : K_PARA);
    }
    if (c0 === 35) {
      pkHeading = headingOf(line);
      return (k = pkHeading !== null ? K_HEADING : K_PARA);
    }
    if (c0 === 62) return (k = K_QUOTE);
    if (c0 === 45 || c0 === 42) {
      if (isHr(line)) return (k = K_HR);
      pkMarker = listMarker(line);
      return (k = pkMarker !== null ? K_LIST : K_PARA);
    }
    if (c0 >= 48 && c0 <= 57) {
      pkMarker = listMarker(line);
      return (k = pkMarker !== null ? K_LIST : K_PARA);
    }
    return (k = K_PARA);
  };
  const adv = () => {
    i++;
    k = -1;
  };
  while (i < n) {
    const line = lines[i];
    const kind = getK();
    if (kind === K_BLANK) {
      adv();
      continue;
    }
    if (kind === K_FENCE) {
      const lang = pkLang;
      let code = '';
      adv();
      while (i < n && !fenceClose(lines[i])) code += escapeHtml(lines[i++]) + '\n';
      adv();
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>\n`);
      continue;
    }
    if (kind === K_HEADING) {
      const heading = pkHeading;
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      adv();
      continue;
    }
    if (kind === K_HR) {
      blocks.push('<hr>\n');
      adv();
      continue;
    }
    if (kind === K_QUOTE) {
      const inner = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const stripped = l.startsWith('> ') ? l.slice(2) : l.slice(1);
        const t = trimLine(stripped);
        if (t !== '') inner.push(t);
      }
      k = -1;
      blocks.push(inner.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(inner.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    if (kind === K_LIST) {
      const marker = pkMarker;
      const isOrdered = marker.ordered;
      const items = [];
      let cur = [trimLine(marker.text)];
      items.push(cur);
      adv();
      while (i < n) {
        const m2 = listMarker(lines[i]);
        if (m2 !== null && m2.ordered === isOrdered) {
          cur = [trimLine(m2.text)];
          items.push(cur);
          i++;
        } else if (isContinued(lines[i])) {
          cur.push(trimLine(lines[i]));
          i++;
        } else break;
      }
      k = -1;
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && marker.start !== 1 ? `<ol start="${marker.start}">` : `<${tag}>`;
      let s = open + '\n';
      for (const it of items) s += `<li>${inline(it.join('\n'), env)}</li>\n`;
      s += `</${tag}>\n`;
      blocks.push(s);
      continue;
    }
    const body = [trimLine(line)];
    adv();
    while (i < n) {
      const k2 = getK();
      if (k2 === K_BLANK || k2 === K_FENCE || k2 === K_HEADING || k2 === K_HR) break;
      body.push(trimLine(lines[i]));
      adv();
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain (an array of vars objects, innermost
 * last): its first name from the nearest scope holding it, then own properties. */
function lookup(scopes, path) {
  for (let d = scopes.length - 1; d >= 0; d--) {
    const vars = scopes[d];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` in `scopes` (an array of vars objects, innermost
 * last); `ctx` holds the parsed templates. */
function renderNodes(nodes, scopes, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(scopes, n.path);
        out.push(typeof v === 'string' ? escapeHtml(v) : escapeHtml(textOf(v)));
        break;
      }
      case 'raw':
        out.push(textOf(lookup(scopes, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scopes, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scopes, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scopes, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          scopes.push({ [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } });
          renderNodes(n.body, scopes, ctx, depth, out);
          scopes.pop();
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scopes, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's output directory and url, its slug unique in its directory.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, { link });
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => {
      const slug = slugify(name);
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const output = {};
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, [{ site, tags: allTags, recent, ...vars }], ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
