/**
 * EW-641 Phase 1B/d row 10 — allowlist-based HTML sanitiser for the
 * DOCX viewer canvas.
 *
 * Mammoth's `convertToHtml` produces simple block markup (`<p>`,
 * `<h1-h6>`, lists, tables, basic inline emphasis) plus the
 * occasional `<img src="data:image/...;base64,...">` for embedded
 * pictures. It does not emit `<script>` / `<iframe>` / `on*` event
 * handlers under normal use — but a malicious uploader could embed
 * raw HTML inside an oMath element or rely on a Word feature we
 * don't know about. The sanitiser is the belt-and-braces guard:
 * any element or attribute outside the allowlist is stripped before
 * the HTML reaches `dangerouslySetInnerHTML`.
 *
 * Design:
 *  - DOMParser based — runs in the browser; SSR callers should never
 *    invoke this (the canvas is `next/dynamic`-loaded with ssr:false).
 *  - Reasonably comprehensive allowlist for the elements mammoth
 *    actually emits + a couple of nice-to-haves (`<sup>`, `<sub>`,
 *    `<details>` blocks).
 *  - URL schemes restricted to `http:`, `https:`, `mailto:`, and
 *    `data:image/...` — `javascript:` href / src is dropped.
 */

const ALLOWED_TAGS = new Set([
    'a',
    'b',
    'blockquote',
    'br',
    'code',
    'div',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'i',
    'img',
    'li',
    'ol',
    'p',
    'pre',
    'span',
    'strong',
    'sub',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
]);

const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
    a: new Set(['href', 'title', 'rel', 'target']),
    img: new Set(['src', 'alt', 'title', 'width', 'height']),
    td: new Set(['colspan', 'rowspan', 'align']),
    th: new Set(['colspan', 'rowspan', 'scope', 'align']),
    table: new Set(['border', 'cellpadding', 'cellspacing']),
    ol: new Set(['start', 'type']),
};

const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

function isSafeUrl(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    // Data URLs only allowed for images.
    if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(trimmed)) return true;
    // Absolute or scheme-relative — verify scheme.
    if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) {
        try {
            const parsed = new URL(trimmed);
            return ALLOWED_URL_SCHEMES.has(parsed.protocol.toLowerCase());
        } catch {
            return false;
        }
    }
    // Relative URL (no scheme) — accept.
    return true;
}

/**
 * Returns a sanitised copy of the input HTML. Drops any element /
 * attribute outside the allowlist. Always returns a string — empty
 * input yields an empty string.
 */
export function sanitizeDocxHtml(html: string): string {
    if (!html || typeof DOMParser === 'undefined') return '';

    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const root = doc.body.firstElementChild;
    if (!root) return '';

    walk(root);

    return root.innerHTML;
}

function walk(node: Element): void {
    // Iterate over a snapshot — we mutate during traversal.
    const children = Array.from(node.children);
    for (const child of children) {
        const tag = child.tagName.toLowerCase();
        if (!ALLOWED_TAGS.has(tag)) {
            child.remove();
            continue;
        }

        // Strip every attribute outside the per-tag allowlist + any
        // attribute starting with `on` (event handler).
        const allowed = ALLOWED_ATTRS[tag] ?? new Set<string>();
        // Snapshot the attribute names so removal during iteration
        // doesn't shift indices.
        const attrNames = Array.from(child.attributes).map((a) => a.name);
        for (const name of attrNames) {
            const lower = name.toLowerCase();
            if (lower.startsWith('on')) {
                child.removeAttribute(name);
                continue;
            }
            if (!allowed.has(lower)) {
                child.removeAttribute(name);
                continue;
            }
            // URL-bearing attrs need extra vetting.
            if (lower === 'href' || lower === 'src') {
                const value = child.getAttribute(name) ?? '';
                if (!isSafeUrl(value)) {
                    child.removeAttribute(name);
                }
            }
        }

        // Force-secure outbound links.
        if (tag === 'a' && child.hasAttribute('href')) {
            const rel = (child.getAttribute('rel') ?? '').trim();
            const merged = new Set(rel.split(/\s+/).filter(Boolean));
            merged.add('noopener');
            merged.add('noreferrer');
            child.setAttribute('rel', Array.from(merged).join(' '));
            if (child.getAttribute('target') !== '_blank') {
                child.setAttribute('target', '_blank');
            }
        }

        walk(child);
    }
}
