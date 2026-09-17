#!/usr/bin/env node
// AW-25 Help centre — build the in-product manual from the documentation site.
//
// The manual is NOT a second copy of our documentation. Its articles are the
// pages under `docs/` that `apps/web/src/content/help/manual.json` lists, and
// this script is the only thing that turns them into what the web app renders:
//
//   1. `src/lib/help/help-catalog.generated.ts` — COMMITTED, eager metadata:
//      id, section, title, summary, keywords, the screens each article
//      documents (keys of ROUTES), related articles, and every addressable
//      heading. The `HelpTarget` union type is derived from it, so a help link
//      pointing at an article or heading that does not exist is a `tsc` error.
//   2. `public/help-content/<id>.json` — NOT committed (gitignored), one
//      structured body per article, written at build time (`prebuild` /
//      `predev`) and served by the running deployment itself. Bodies are a
//      closed block grammar (see `@ever-works/contracts` `HelpBlock`); nothing
//      is ever emitted as raw markup.
//
// Usage (from apps/web):
//   node scripts/build-help-catalog.mjs            write the catalog and the bodies
//   node scripts/build-help-catalog.mjs --check    exit 1 when the committed catalog is stale
//   node scripts/build-help-catalog.mjs --bodies   write the bodies only (build / dev servers)
//
// `--bodies` never fails a build because the committed catalog drifted from a
// later docs edit — it warns instead; the drift gate is
// `src/lib/help/help-catalog.unit.spec.ts`, which runs in CI. When `docs/` is
// not present at all (a pruned build context), `--bodies` warns and exits 0 and
// the manual renders each article's summary with a link to the published page.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const REPO_ROOT = resolve(WEB_ROOT, '..', '..');
export const MANIFEST_PATH = join(WEB_ROOT, 'src', 'content', 'help', 'manual.json');
export const CATALOG_PATH = join(WEB_ROOT, 'src', 'lib', 'help', 'help-catalog.generated.ts');
export const BODIES_DIR = join(WEB_ROOT, 'public', 'help-content');
export const DOCS_SITE_URL = 'https://docs.ever.works';

/** Mirrors `HELP_SECTIONS` in @ever-works/contracts — the catalog spec asserts they agree. */
export const HELP_SECTIONS = [
    'start-here',
    'running-the-loop',
    'your-agents',
    'setup-and-connections',
    'money-and-limits',
    'when-something-goes-wrong',
];

/** Mirrors `HELP_LIMITS` in @ever-works/contracts — the catalog spec asserts they agree. */
export const LIMITS = {
    maxArticles: 200,
    titleChars: 70,
    summaryChars: 200,
    bodyChars: 60_000,
    maxHeadings: 80,
    headingIdMinChars: 2,
    headingIdMaxChars: 96,
    maxKeywords: 12,
    keywordChars: 32,
    maxDocuments: 8,
    maxRelated: 5,
    linkLabelChars: 80,
    externalHrefChars: 2048,
};

const ARTICLE_ID = /^[a-z0-9-]{3,64}$/;
const ROUTE_KEY = /^[A-Z][A-Z0-9_]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_TONES = {
    note: 'note',
    tip: 'tip',
    info: 'info',
    important: 'info',
    success: 'tip',
    secondary: 'note',
    caution: 'warning',
    warning: 'warning',
    danger: 'danger',
};

// ─── Front matter ──────────────────────────────────────────────────────────

/**
 * Split a Markdown file into its YAML-ish front matter (flat `key: value`
 * pairs only — all the manual needs) and its body. `bodyLine` is the 1-based
 * line number the body starts on, so errors can name the source line.
 */
export function splitFrontMatter(source) {
    const text = source.replace(/\r\n?/g, '\n');
    if (!text.startsWith('---\n')) return { data: {}, body: text, bodyLine: 1 };
    const end = text.indexOf('\n---', 4);
    if (end === -1) return { data: {}, body: text, bodyLine: 1 };
    const data = {};
    for (const line of text.slice(4, end).split('\n')) {
        const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (!m) continue;
        let value = m[2].trim();
        if (
            (value.startsWith("'") && value.endsWith("'")) ||
            (value.startsWith('"') && value.endsWith('"'))
        ) {
            value = value.slice(1, -1);
        }
        data[m[1]] = value;
    }
    const afterFence = text.indexOf('\n', end + 1);
    const body = afterFence === -1 ? '' : text.slice(afterFence + 1);
    const bodyLine = text
        .slice(0, afterFence === -1 ? text.length : afterFence + 1)
        .split('\n').length;
    return { data, body, bodyLine };
}

// ─── Headings ──────────────────────────────────────────────────────────────

/**
 * Heading anchor ids, computed the way the documentation site computes them
 * (lower-case, punctuation dropped, each space becomes a hyphen) so an anchor
 * copied from the published page resolves in the product too.
 */
export function slugifyHeading(text) {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
        .replace(/ /g, '-');
}

function createSlugger() {
    const seen = new Map();
    return (text) => {
        const base = slugifyHeading(text) || 'section';
        let slug = base;
        let n = seen.get(base) ?? 0;
        while (seen.has(slug)) {
            n += 1;
            slug = `${base}-${n}`;
        }
        seen.set(base, n);
        seen.set(slug, 0);
        return slug;
    };
}

// ─── Inline content ────────────────────────────────────────────────────────

export function inlineText(nodes) {
    return nodes
        .map((node) =>
            node.type === 'text' || node.type === 'code' ? node.text : inlineText(node.children),
        )
        .join('');
}

function findClosing(text, from, open, close) {
    let depth = 0;
    for (let i = from; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '\\') {
            i += 1;
            continue;
        }
        if (ch === '`') {
            const end = text.indexOf('`', i + 1);
            if (end === -1) return -1;
            i = end;
            continue;
        }
        if (ch === open) depth += 1;
        if (ch === close) {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

/** `[label](target "title")` starting at `start` (the `[`). */
function matchLink(text, start) {
    const labelEnd = findClosing(text, start, '[', ']');
    if (labelEnd === -1 || text[labelEnd + 1] !== '(') return null;
    const targetEnd = findClosing(text, labelEnd + 1, '(', ')');
    if (targetEnd === -1) return null;
    const rawTarget = text
        .slice(labelEnd + 2, targetEnd)
        .trim()
        .replace(/\s+["'(].*["')]$/, '')
        .replace(/^<(.*)>$/, '$1');
    return { label: text.slice(start + 1, labelEnd), target: rawTarget, end: targetEnd + 1 };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Append inline nodes, merging adjacent text so an unlinked label reads as one run of text. */
function appendInline(out, nodes) {
    for (const node of nodes) {
        const last = out[out.length - 1];
        if (node.type === 'text' && last && last.type === 'text') last.text += node.text;
        else out.push(node);
    }
}

/** Parse one line (or a joined paragraph) of inline Markdown into `HelpInline` nodes. */
export function parseInline(text, ctx) {
    const out = [];
    let buf = '';
    const flush = () => {
        if (buf) {
            const last = out[out.length - 1];
            if (last && last.type === 'text') last.text += buf;
            else out.push({ type: 'text', text: buf });
            buf = '';
        }
    };
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|<>~]/.test(text[i + 1])) {
            buf += text[i + 1];
            i += 2;
            continue;
        }
        if (ch === '`') {
            let run = 1;
            while (text[i + run] === '`') run += 1;
            const fence = '`'.repeat(run);
            const end = text.indexOf(fence, i + run);
            if (end !== -1) {
                flush();
                const code = text.slice(i + run, end);
                out.push({ type: 'code', text: /^ .* $/.test(code) ? code.slice(1, -1) : code });
                i = end + run;
                continue;
            }
            buf += fence;
            i += run;
            continue;
        }
        if (ch === '!' && text[i + 1] === '[') {
            const link = matchLink(text, i + 1);
            if (link) {
                ctx.warn(
                    `image "${link.target}" is not part of the manual grammar; its alt text is shown`,
                );
                buf += link.label;
                i = link.end;
                continue;
            }
        }
        if (ch === '[') {
            const link = matchLink(text, i);
            if (link) {
                flush();
                const children = parseInline(link.label, ctx);
                const target = ctx.resolveTarget(link.target);
                if (target) out.push({ type: 'link', children, target });
                else appendInline(out, children);
                i = link.end;
                continue;
            }
        }
        if (ch === '<') {
            const rest = text.slice(i);
            const auto = /^<(https?:\/\/[^>\s]+)>/.exec(rest);
            if (auto) {
                flush();
                const target = ctx.resolveTarget(auto[1]);
                const children = [{ type: 'text', text: auto[1] }];
                if (target) out.push({ type: 'link', children, target });
                else appendInline(out, children);
                i += auto[0].length;
                continue;
            }
            const tag = /^<\/?[A-Za-z][A-Za-z0-9-]*(\s[^<>]*)?\/?>/.exec(rest);
            if (tag) {
                ctx.warn(`inline HTML ${tag[0]} is not part of the manual grammar and was dropped`);
                i += tag[0].length;
                continue;
            }
        }
        if (
            (ch === '*' || ch === '_') &&
            text[i + 1] === ch &&
            text[i + 2] &&
            text[i + 2] !== ' '
        ) {
            const close = text.indexOf(ch + ch, i + 2);
            if (close > i + 2) {
                flush();
                out.push({ type: 'strong', children: parseInline(text.slice(i + 2, close), ctx) });
                i = close + 2;
                continue;
            }
        }
        if (
            (ch === '*' || ch === '_') &&
            text[i + 1] &&
            text[i + 1] !== ' ' &&
            text[i + 1] !== ch
        ) {
            const prev = text[i - 1];
            if (ch === '*' || !prev || !WORD_CHAR.test(prev)) {
                let close = -1;
                for (let j = i + 1; j < text.length; j += 1) {
                    if (text[j] === '`') {
                        const e = text.indexOf('`', j + 1);
                        if (e === -1) break;
                        j = e;
                        continue;
                    }
                    if (
                        text[j] === ch &&
                        text[j - 1] !== ' ' &&
                        text[j + 1] !== ch &&
                        (ch === '*' || !text[j + 1] || !WORD_CHAR.test(text[j + 1]))
                    ) {
                        close = j;
                        break;
                    }
                }
                if (close > i + 1) {
                    flush();
                    out.push({
                        type: 'emphasis',
                        children: parseInline(text.slice(i + 1, close), ctx),
                    });
                    i = close + 1;
                    continue;
                }
            }
        }
        buf += ch;
        i += 1;
    }
    flush();
    return out;
}

// ─── Blocks ────────────────────────────────────────────────────────────────

const RE = {
    fence: /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)?.*$/,
    heading: /^(#{1,6})\s+(.+?)\s*#*\s*$/,
    hr: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
    admonitionOpen: /^\s*:::([a-z]+)\s*(.*)$/,
    admonitionClose: /^\s*:::\s*$/,
    listItem: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
    tableSeparator: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
    blockquote: /^\s*>\s?(.*)$/,
    htmlComment: /^\s*<!--/,
    htmlBlock: /^\s*<\/?[A-Za-z!]/,
};

const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === '';

function isTableStart(lines, i) {
    return (
        lines[i].trim().startsWith('|') &&
        i + 1 < lines.length &&
        RE.tableSeparator.test(lines[i + 1])
    );
}

function startsBlock(lines, i) {
    const line = lines[i];
    return (
        RE.fence.test(line) ||
        RE.heading.test(line) ||
        RE.hr.test(line) ||
        RE.admonitionOpen.test(line) ||
        RE.admonitionClose.test(line) ||
        RE.listItem.test(line) ||
        RE.blockquote.test(line) ||
        RE.htmlComment.test(line) ||
        isTableStart(lines, i)
    );
}

function splitTableRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    let inCode = false;
    for (let i = 0; i < s.length; i += 1) {
        const c = s[i];
        if (c === '\\' && s[i + 1] === '|') {
            cur += '\\|';
            i += 1;
            continue;
        }
        if (c === '`') inCode = !inCode;
        if (c === '|' && !inCode) {
            cells.push(cur.trim());
            cur = '';
            continue;
        }
        cur += c;
    }
    cells.push(cur.trim());
    return cells;
}

function dedent(lines) {
    const width = Math.min(...lines.filter((l) => !isBlank(l)).map(indentOf));
    return Number.isFinite(width) ? lines.map((l) => l.slice(Math.min(width, indentOf(l)))) : lines;
}

/**
 * Parse an article body into the closed block grammar. Pure — no file I/O —
 * so the grammar is unit-testable. `ctx` supplies the article identity, the
 * link resolver and a warning sink; `ctx.line` is the 1-based line of
 * `lines[0]` in the source file.
 */
export function parseArticleBody(source, ctx) {
    const state = {
        slug: createSlugger(),
        headings: [],
        anchors: new Set(),
    };
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const blocks = parseBlocks(lines, ctx.line ?? 1, ctx, state);
    return { blocks, headings: state.headings, anchors: state.anchors };
}

function parseBlocks(lines, firstLine, ctx, state) {
    const blocks = [];
    let i = 0;
    const at = (index) => firstLine + index;
    const warnAt = (index, message) => ctx.warn(message, at(index));
    const inlineAt = (index, text) =>
        parseInline(text, { ...ctx, warn: (message) => warnAt(index, message) });

    while (i < lines.length) {
        const line = lines[i];
        if (isBlank(line)) {
            i += 1;
            continue;
        }

        if (RE.htmlComment.test(line)) {
            while (i < lines.length && !lines[i].includes('-->')) i += 1;
            i += 1;
            continue;
        }

        const fence = RE.fence.exec(line);
        if (fence) {
            const marker = fence[2];
            const start = i;
            const body = [];
            i += 1;
            while (i < lines.length && !lines[i].trim().startsWith(marker)) {
                body.push(lines[i]);
                i += 1;
            }
            if (i >= lines.length) warnAt(start, 'code block is never closed');
            i += 1;
            blocks.push({
                kind: 'code',
                language: fence[3] || null,
                text: dedent(body).join('\n'),
            });
            continue;
        }

        const admonition = RE.admonitionOpen.exec(line);
        if (admonition) {
            const start = i;
            const inner = [];
            let depth = 1;
            i += 1;
            while (i < lines.length) {
                if (RE.admonitionClose.test(lines[i])) {
                    depth -= 1;
                    if (depth === 0) break;
                } else if (RE.admonitionOpen.test(lines[i])) {
                    depth += 1;
                }
                inner.push(lines[i]);
                i += 1;
            }
            if (i >= lines.length) warnAt(start, `callout ":::${admonition[1]}" is never closed`);
            i += 1;
            const tone = NOTE_TONES[admonition[1]];
            if (!tone)
                warnAt(start, `unknown callout type ":::${admonition[1]}" rendered as a note`);
            const titleText = admonition[2].trim();
            blocks.push({
                kind: 'note',
                tone: tone ?? 'note',
                title: titleText ? inlineText(inlineAt(start, titleText)) : null,
                blocks: parseBlocks(inner, at(start + 1), ctx, state),
            });
            continue;
        }

        if (RE.admonitionClose.test(line)) {
            warnAt(i, 'stray ":::" with no open callout');
            i += 1;
            continue;
        }

        const heading = RE.heading.exec(line);
        if (heading) {
            const level = heading[1].length;
            i += 1;
            if (level === 1) continue; // the page title is rendered from front matter
            let raw = heading[2];
            let explicitId = null;
            const custom = /\s*\{#([A-Za-z0-9_-]+)\}\s*$/.exec(raw);
            if (custom) {
                explicitId = custom[1];
                raw = raw.slice(0, custom.index);
            }
            const content = inlineAt(i - 1, raw);
            const text = inlineText(content).trim();
            const id = explicitId ?? state.slug(text);
            state.anchors.add(id);
            const clamped = Math.min(level, 4);
            if (clamped <= 3) state.headings.push({ id, text, level: clamped });
            blocks.push({ kind: 'heading', level: clamped, id, content });
            continue;
        }

        if (RE.hr.test(line)) {
            i += 1;
            continue;
        }

        if (isTableStart(lines, i)) {
            const header = splitTableRow(lines[i]).map((cell) => inlineAt(i, cell));
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].trim().startsWith('|')) {
                const index = i;
                rows.push(splitTableRow(lines[i]).map((cell) => inlineAt(index, cell)));
                i += 1;
            }
            blocks.push({ kind: 'table', header, rows });
            continue;
        }

        if (RE.blockquote.test(line)) {
            const start = i;
            const inner = [];
            while (i < lines.length && RE.blockquote.test(lines[i])) {
                inner.push(RE.blockquote.exec(lines[i])[1]);
                i += 1;
            }
            blocks.push({
                kind: 'note',
                tone: 'info',
                title: null,
                blocks: parseBlocks(inner, at(start), ctx, state),
            });
            continue;
        }

        const item = RE.listItem.exec(line);
        if (item) {
            const parsed = parseList(lines, i, firstLine, ctx, state);
            blocks.push(parsed.block);
            i = parsed.next;
            continue;
        }

        if (RE.htmlBlock.test(line)) {
            warnAt(
                i,
                `HTML "${line.trim().slice(0, 40)}" is not part of the manual grammar and was dropped`,
            );
            while (i < lines.length && !isBlank(lines[i])) i += 1;
            continue;
        }

        const start = i;
        const paragraph = [line.trim()];
        i += 1;
        while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) {
            paragraph.push(lines[i].trim());
            i += 1;
        }
        blocks.push({ kind: 'paragraph', content: inlineAt(start, paragraph.join(' ')) });
    }
    return blocks;
}

function parseList(lines, startIndex, firstLine, ctx, state) {
    const first = RE.listItem.exec(lines[startIndex]);
    const baseIndent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const items = [];
    let i = startIndex;
    const inlineAt = (index, text) =>
        parseInline(text, { ...ctx, warn: (message) => ctx.warn(message, firstLine + index) });

    const sameList = (index) => {
        const m = index < lines.length ? RE.listItem.exec(lines[index]) : null;
        return m !== null && m[1].length === baseIndent && /\d/.test(m[2]) === ordered;
    };
    while (i < lines.length) {
        // A "loose" list separates its items with blank lines; the list goes on
        // when the next non-blank line is another item at the same depth.
        if (isBlank(lines[i])) {
            let next = i;
            while (next < lines.length && isBlank(lines[next])) next += 1;
            if (!sameList(next)) break;
            i = next;
        }
        const m = RE.listItem.exec(lines[i]);
        if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
        const itemLine = i;
        const contentIndent = m[1].length + m[2].length + 1;
        const text = [m[3].trim()];
        const rest = [];
        let restLine = null;
        i += 1;
        let inParagraph = true;
        while (i < lines.length) {
            const line = lines[i];
            if (isBlank(line)) {
                let next = i + 1;
                while (next < lines.length && isBlank(lines[next])) next += 1;
                if (next < lines.length && indentOf(lines[next]) > baseIndent) {
                    inParagraph = false;
                    rest.push('');
                    i += 1;
                    continue;
                }
                break;
            }
            const indent = indentOf(line);
            if (indent <= baseIndent && RE.listItem.test(line)) break;
            if (indent > baseIndent) {
                const stripped = line.slice(Math.min(indent, contentIndent));
                if (inParagraph && !startsBlock([stripped.trimStart(), ...lines.slice(i + 1)], 0)) {
                    text.push(stripped.trim());
                } else {
                    inParagraph = false;
                    if (restLine === null) restLine = i;
                    rest.push(stripped);
                }
                i += 1;
                continue;
            }
            if (inParagraph && !startsBlock(lines, i)) {
                text.push(line.trim());
                i += 1;
                continue;
            }
            break;
        }
        const children = rest.some((l) => !isBlank(l))
            ? parseBlocks(dedent(rest), firstLine + (restLine ?? itemLine), ctx, state)
            : [];
        items.push({ content: inlineAt(itemLine, text.join(' ')), children });
    }
    return { block: { kind: ordered ? 'orderedList' : 'unorderedList', items }, next: i };
}

// ─── Links ─────────────────────────────────────────────────────────────────

function docUrlPath(docPath, data) {
    const rel = docPath.replace(/^docs\//, '');
    const dir = posix.dirname(rel);
    if (data.slug) {
        if (data.slug.startsWith('/')) return data.slug.replace(/^\//, '');
        return posix.join(dir === '.' ? '' : dir, data.slug);
    }
    const leaf = data.id || basename(rel).replace(/\.mdx?$/, '');
    return dir === '.' ? leaf : `${dir}/${leaf}`;
}

function locateDoc(repoRoot, candidate) {
    const normalized = posix.normalize(candidate).replace(/\/$/, '');
    const options = /\.mdx?$/.test(normalized)
        ? [normalized]
        : [`${normalized}.md`, `${normalized}.mdx`, `${normalized}/index.md`];
    return (
        options.find(
            (option) => option.startsWith('docs/') && existsSync(join(repoRoot, option)),
        ) ?? null
    );
}

function createResolver({
    repoRoot,
    sourcePath,
    articleId,
    articlesBySource,
    articleIds,
    pendingAnchors,
    warn,
}) {
    return (raw) => {
        const value = raw.trim();
        if (!value) {
            warn('link with an empty target rendered as text');
            return null;
        }
        if (value.startsWith('help:')) {
            const [id, heading] = value.slice(5).split('#');
            if (!articleIds.has(id)) {
                warn(`link to unknown article "${id}" rendered as text`);
                return null;
            }
            const target = { type: 'article', articleId: id, headingId: heading || null };
            if (heading) pendingAnchors.push({ target, warn });
            return target;
        }
        if (value.startsWith('route:')) {
            const key = value.slice(6);
            if (!ROUTE_KEY.test(key)) {
                warn(`link to "${value}" is not a ROUTES key and was rendered as text`);
                return null;
            }
            return { type: 'screen', routeKey: key };
        }
        if (value.startsWith('#')) {
            const target = { type: 'article', articleId, headingId: value.slice(1) || null };
            if (target.headingId) pendingAnchors.push({ target, warn });
            return target;
        }
        if (/^https:\/\//i.test(value)) {
            let url;
            try {
                url = new URL(value);
            } catch {
                warn(`malformed address "${value}" rendered as text`);
                return null;
            }
            if (url.username || url.password || value.length > LIMITS.externalHrefChars) {
                warn(
                    `external address "${value}" carries credentials or is too long; rendered as text`,
                );
                return null;
            }
            return { type: 'external', href: url.toString() };
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) {
            warn(`link "${value}" does not use https and was rendered as text`);
            return null;
        }
        const [pathPart, anchor] = value.split('#');
        const candidate = pathPart.startsWith('/')
            ? `docs${pathPart}`
            : posix.join(posix.dirname(sourcePath), pathPart || posix.basename(sourcePath));
        const docPath = locateDoc(repoRoot, candidate);
        if (!docPath) {
            warn(
                `link "${value}" does not resolve to a documentation page and was rendered as text`,
            );
            return null;
        }
        const linked = articlesBySource.get(docPath);
        if (linked) {
            const target = { type: 'article', articleId: linked, headingId: anchor || null };
            if (anchor) pendingAnchors.push({ target, warn });
            return target;
        }
        const { data } = splitFrontMatter(readFileSync(join(repoRoot, docPath), 'utf8'));
        const href = `${DOCS_SITE_URL}/${docUrlPath(docPath, data)}${anchor ? `#${anchor}` : ''}`;
        return { type: 'external', href };
    };
}

// ─── The manual ────────────────────────────────────────────────────────────

export function readManifest(path = MANIFEST_PATH) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Build the whole manual in memory. Returns the committed catalog source, the
 * per-article bodies, and every error (hard failures) and warning (constructs
 * rendered in a degraded form). Performs no writes.
 */
export function buildHelpManual({ repoRoot = REPO_ROOT, manifest = readManifest() } = {}) {
    const errors = [];
    const warnings = [];
    const entries = Array.isArray(manifest?.articles) ? manifest.articles : [];
    if (entries.length === 0) errors.push('manual.json: "articles" must be a non-empty array');
    if (entries.length > LIMITS.maxArticles) {
        errors.push(
            `manual.json: ${entries.length} articles exceeds the limit of ${LIMITS.maxArticles}`,
        );
    }

    // Pass 1 — identity, so links between articles can resolve.
    const prepared = [];
    const articlesBySource = new Map();
    const articleIds = new Set();
    for (const [index, entry] of entries.entries()) {
        const where = `manual.json articles[${index}]`;
        const source = typeof entry?.source === 'string' ? entry.source : '';
        if (!/^docs\/.+\.mdx?$/.test(source) || !existsSync(join(repoRoot, source))) {
            errors.push(`${where}: source "${source}" is not a Markdown file under docs/`);
            continue;
        }
        const raw = readFileSync(join(repoRoot, source), 'utf8');
        const { data, body, bodyLine } = splitFrontMatter(raw);
        const id = data.id || basename(source).replace(/\.mdx?$/, '');
        if (!ARTICLE_ID.test(id))
            errors.push(`${source}: article id "${id}" must match ${ARTICLE_ID}`);
        if (articleIds.has(id)) errors.push(`${source}: duplicate article id "${id}"`);
        articleIds.add(id);
        articlesBySource.set(source, id);
        prepared.push({ entry, source, data, body, bodyLine, id });
    }

    // Pass 2 — bodies, headings and metadata.
    const pendingAnchors = [];
    const articles = [];
    const bodies = [];
    const anchorsById = new Map();
    for (const { entry, source, data, body, bodyLine, id } of prepared) {
        const fail = (rule) => errors.push(`${source}: ${rule}`);
        const warn = (message, line) =>
            warnings.push(`${source}${line ? `:${line}` : ''}: ${message}`);

        const title = (data.title || '').trim();
        if (!title) fail('front matter has no title');
        if (title.length > LIMITS.titleChars)
            fail(`title is longer than ${LIMITS.titleChars} characters`);
        if (!HELP_SECTIONS.includes(entry.section))
            fail(`section "${entry.section}" is not one of ${HELP_SECTIONS.join(', ')}`);
        if (!Number.isInteger(entry.order)) fail('order must be an integer');
        const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
        if (!summary || summary.length > LIMITS.summaryChars)
            fail(`summary must be 1-${LIMITS.summaryChars} characters`);
        const keywords = Array.isArray(entry.keywords) ? entry.keywords : [];
        if (keywords.length > LIMITS.maxKeywords) fail(`more than ${LIMITS.maxKeywords} keywords`);
        for (const keyword of keywords) {
            if (
                typeof keyword !== 'string' ||
                !keyword.trim() ||
                keyword.length > LIMITS.keywordChars
            ) {
                fail(`keyword "${keyword}" must be 1-${LIMITS.keywordChars} characters`);
            }
        }
        const documents = Array.isArray(entry.documents) ? entry.documents : [];
        if (documents.length > LIMITS.maxDocuments)
            fail(`documents more than ${LIMITS.maxDocuments} screens`);
        for (const key of documents) {
            if (typeof key !== 'string' || !ROUTE_KEY.test(key))
                fail(`documents entry "${key}" is not a ROUTES key`);
        }
        if (new Set(documents).size !== documents.length) fail('documents lists a screen twice');
        const related = Array.isArray(entry.related) ? entry.related : [];
        if (related.length > LIMITS.maxRelated)
            fail(`more than ${LIMITS.maxRelated} related articles`);
        for (const other of related) {
            if (other === id) fail('an article cannot be related to itself');
            else if (!articleIds.has(other))
                fail(`related article "${other}" is not in the manual`);
        }
        const reviewedAt = typeof entry.reviewedAt === 'string' ? entry.reviewedAt : '';
        if (!ISO_DATE.test(reviewedAt) || Number.isNaN(Date.parse(reviewedAt))) {
            fail(`reviewedAt "${reviewedAt}" must be a YYYY-MM-DD date`);
        }
        if (body.length > LIMITS.bodyChars)
            fail(`body is longer than ${LIMITS.bodyChars} characters`);

        const resolveTarget = createResolver({
            repoRoot,
            sourcePath: source,
            articleId: id,
            articlesBySource,
            articleIds,
            pendingAnchors,
            warn,
        });
        const parsed = parseArticleBody(body, {
            articleId: id,
            line: bodyLine,
            resolveTarget,
            warn,
        });
        if (parsed.headings.length === 0) fail('has no "##" heading to link to');
        if (parsed.headings.length > LIMITS.maxHeadings)
            fail(`more than ${LIMITS.maxHeadings} headings`);
        for (const heading of parsed.headings) {
            if (
                heading.id.length < LIMITS.headingIdMinChars ||
                heading.id.length > LIMITS.headingIdMaxChars
            ) {
                fail(
                    `heading "${heading.text}" has an anchor outside ${LIMITS.headingIdMinChars}-${LIMITS.headingIdMaxChars} characters`,
                );
            }
        }
        anchorsById.set(id, parsed.anchors);

        articles.push({
            id,
            section: entry.section,
            order: entry.order,
            title,
            label: (data.sidebar_label || title).trim(),
            summary,
            keywords: keywords.map((keyword) => keyword.trim()),
            documents,
            related,
            reviewedAt,
            source,
            docsUrl: `${DOCS_SITE_URL}/${docUrlPath(source, data)}`,
            headings: parsed.headings,
        });
        bodies.push({ id, body: { version: 1, id, blocks: parsed.blocks } });
    }

    // Pass 3 — every anchor a link names must exist in the article it points at.
    for (const { target, warn } of pendingAnchors) {
        const anchors = anchorsById.get(target.articleId);
        if (anchors && !anchors.has(target.headingId)) {
            warn(
                `link to "#${target.headingId}" in "${target.articleId}" names a heading that does not exist; it opens the article at the top`,
            );
            target.headingId = null;
        }
    }

    articles.sort(
        (a, b) =>
            HELP_SECTIONS.indexOf(a.section) - HELP_SECTIONS.indexOf(b.section) ||
            a.order - b.order ||
            a.title.localeCompare(b.title, 'en'),
    );

    return { articles, bodies, catalogSource: renderCatalogModule(articles), errors, warnings };
}

// ─── Output ────────────────────────────────────────────────────────────────

function tsString(value) {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function tsValue(value, depth) {
    const pad = '    '.repeat(depth + 1);
    const close = '    '.repeat(depth);
    if (typeof value === 'string') return tsString(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        const inline = `[${value.map((v) => tsValue(v, depth + 1)).join(', ')}]`;
        if (value.every((v) => typeof v !== 'object') && inline.length + depth * 4 <= 80)
            return inline;
        return `[\n${value.map((v) => `${pad}${tsValue(v, depth + 1)},`).join('\n')}\n${close}]`;
    }
    const entries = Object.entries(value);
    const inline = `{ ${entries.map(([k, v]) => `${k}: ${tsValue(v, depth + 1)}`).join(', ')} }`;
    if (entries.every(([, v]) => typeof v !== 'object') && inline.length + depth * 4 <= 90)
        return inline;
    return `{\n${entries.map(([k, v]) => `${pad}${k}: ${tsValue(v, depth + 1)},`).join('\n')}\n${close}}`;
}

export function renderCatalogModule(articles) {
    return [
        '/**',
        ' * GENERATED FILE — do not edit by hand.',
        ' *',
        ' * Built by `apps/web/scripts/build-help-catalog.mjs` from the documentation pages listed in',
        ' * `apps/web/src/content/help/manual.json`. Regenerate with',
        ' * `pnpm --filter ever-works-web help:build`; `help-catalog.unit.spec.ts` fails when this file',
        ' * no longer matches the documentation it was built from.',
        ' */',
        "import type { HelpArticleMeta } from './help-types';",
        '',
        `export const HELP_ARTICLES = ${tsValue(articles, 0)} as const satisfies readonly HelpArticleMeta[];`,
        '',
    ].join('\n');
}

export function writeBodies(bodies, dir = BODIES_DIR) {
    mkdirSync(dir, { recursive: true });
    const keep = new Set(bodies.map(({ id }) => `${id}.json`));
    for (const file of readdirSync(dir)) {
        if (file.endsWith('.json') && !keep.has(file)) rmSync(join(dir, file));
    }
    for (const { id, body } of bodies) {
        writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(body)}\n`);
    }
}

export function readCommittedCatalog(path = CATALOG_PATH) {
    return existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n?/g, '\n') : null;
}

function main(argv) {
    const check = argv.includes('--check');
    const bodiesOnly = argv.includes('--bodies');
    const log = (message) => process.stdout.write(`[help] ${message}\n`);

    if (!existsSync(join(REPO_ROOT, 'docs'))) {
        const message =
            'docs/ is not present in this build context; the manual will show article summaries only.';
        if (bodiesOnly) {
            log(`WARNING: ${message}`);
            return 0;
        }
        log(`ERROR: ${message}`);
        return 1;
    }

    const result = buildHelpManual();
    for (const warning of result.warnings) log(`WARNING ${warning}`);
    if (result.errors.length > 0) {
        for (const error of result.errors) log(`ERROR ${error}`);
        return 1;
    }

    const stale = readCommittedCatalog() !== result.catalogSource;
    if (check) {
        if (stale) {
            log(
                'ERROR help-catalog.generated.ts is stale — run `pnpm --filter ever-works-web help:build`.',
            );
            return 1;
        }
        if (result.warnings.length > 0) {
            log(
                `ERROR ${result.warnings.length} documentation construct(s) render in a degraded form (see above).`,
            );
            return 1;
        }
        log(`catalog is current (${result.articles.length} articles).`);
        return 0;
    }

    writeBodies(result.bodies);
    log(`wrote ${result.bodies.length} article bodies to public/help-content/.`);
    if (bodiesOnly) {
        if (stale)
            log(
                'WARNING help-catalog.generated.ts is stale — run `pnpm --filter ever-works-web help:build`.',
            );
        return 0;
    }
    mkdirSync(dirname(CATALOG_PATH), { recursive: true });
    writeFileSync(CATALOG_PATH, result.catalogSource);
    log(`wrote help-catalog.generated.ts (${result.articles.length} articles).`);
    return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    process.exitCode = main(process.argv.slice(2));
}
