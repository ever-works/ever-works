/**
 * Server-side SVG sanitizer for category icons.
 *
 * Inputs come from one of three sources:
 *   1. Curated library (trusted, hardcoded Lucide markup).
 *   2. AI generator (untrusted-ish — model output, even with a locked
 *      prompt, can include comments, forbidden tags, or unbalanced markup).
 *   3. User paste via the category modal / taxonomy API (fully untrusted).
 *
 * Output is rendered by the frontend INLINE via `dangerouslySetInnerHTML`
 * (see `apps/web/src/components/works/detail/items/CategoriesTab.tsx`),
 * so the SVG executes in the host document's origin. There is no `<img>`
 * sandbox, no CSP isolation — anything that survives this pass runs with
 * full DOM access. Treat this sanitizer as the only line of defence and
 * fail closed on anything ambiguous. The passes enforced:
 *
 *   - Comments / DOCTYPE / processing instructions / CDATA stripped so
 *     payloads cannot hide inside them.
 *   - Forbidden elements removed: <script>, <foreignObject>, <iframe>,
 *     <embed>, <object>, <animate*>, <set>, <handler>, <listener>.
 *   - Forbidden attributes removed: on* event handlers, xlink:href/href
 *     (the most common SVG XSS vector), inline style (can carry
 *     url(javascript:…)).
 *   - URL schemes rejected anywhere in the body: javascript:, data:,
 *     vbscript:, file:.
 *   - External paint-server references rejected: any `url(<scheme>://…)`
 *     in fill/stroke/filter/etc. would otherwise leak the viewer's IP to
 *     an arbitrary host as a tracking pixel.
 *   - viewBox normalized to "0 0 24 24"; width/height attrs stripped.
 *   - Total length capped at MAX_SVG_LENGTH bytes (matches the DTO cap).
 *
 * The sanitizer is intentionally regex-based to keep the agent package
 * free of jsdom / DOMPurify (heavy server-side deps). For the trust
 * profile above, conservative regex passes that reject anything they
 * can't fully parse are sufficient.
 */

export const MAX_SVG_LENGTH = 4000;

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const DOCTYPE_RE = /<!DOCTYPE[\s\S]*?>/gi;
const PI_RE = /<\?[\s\S]*?\?>/g;
const CDATA_RE = /<!\[CDATA\[[\s\S]*?\]\]>/g;

// Match paired or self-closing forbidden elements. The non-capturing
// group has two arms: self-close (`<script/>`) or full pair
// (`<script ...>body</script>`). Without the explicit `>` after the
// attribute capture, a non-greedy body match would terminate at the
// opening `>` and leave the body intact — which is exactly what we
// were trying to remove.
const FORBIDDEN_ELEMENT_RE =
    /<\s*(script|foreignObject|iframe|embed|object|animate|animateTransform|set|handler|listener)\b[^>]*(?:\/>|>[\s\S]*?<\/\s*\1\s*>)/gi;

const EVENT_HANDLER_ATTR_RE = /\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const DANGEROUS_HREF_RE = /\s+(?:xlink:href|href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const STYLE_ATTR_RE = /\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const WIDTH_HEIGHT_ATTR_RE = /\s+(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

// IMPORTANT: no `g` flag. JavaScript regexes are stateful when `g` is set —
// `RegExp.prototype.test()` advances `lastIndex` between calls, so a match
// at byte offset 50 in call 1 leaves lastIndex at ~62, and a payload whose
// `javascript:` lives before offset 62 in call 2 silently slips through
// (test() returns false, lastIndex resets to 0, alternating bypass).
// `.test()` is an existence check; iteration semantics buy nothing here.
const DANGEROUS_URL_VALUE_RE = /\b(?:javascript|data|vbscript|file)\s*:/i;

// External paint-server references: `url(http://…)`, `url(https://…)`,
// `url(//host/…)`. Local fragment refs like `url(#id)` are fine and stay.
// Without this guard, an attribute like `fill="url(https://tracker/pixel)"`
// turns the inline SVG into an IP-logging beacon for any viewer.
const EXTERNAL_URL_REF_RE = /url\s*\(\s*['"]?\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i;

const SVG_OPEN_TAG_RE = /<svg\b([^>]*)>/i;

const NORMALIZED_VIEWBOX = '0 0 24 24';

export type SanitizeFailureReason =
    | 'empty'
    | 'too-large'
    | 'no-svg-tag'
    | 'unclosed-svg'
    | 'dangerous-content';

export interface SanitizeFailure {
    readonly ok: false;
    readonly reason: SanitizeFailureReason;
}

export interface SanitizeSuccess {
    readonly ok: true;
    readonly svg: string;
    readonly bytes: number;
}

export type SanitizeResult = SanitizeSuccess | SanitizeFailure;

/**
 * Run the sanitizer over an SVG string. Always returns; never throws.
 * On failure, callers should fall back to the curated default icon.
 */
export function sanitizeSvg(input: string | null | undefined): SanitizeResult {
    if (!input || typeof input !== 'string') {
        return { ok: false, reason: 'empty' };
    }

    let working = input.trim();
    if (!working) {
        return { ok: false, reason: 'empty' };
    }

    // Drop comments / DOCTYPE / PIs / CDATA before any structural checks
    // so attackers can't hide payloads inside them.
    working = working
        .replace(COMMENT_RE, '')
        .replace(DOCTYPE_RE, '')
        .replace(PI_RE, '')
        .replace(CDATA_RE, '');

    // Strip forbidden elements wholesale (both paired and self-closing).
    working = working.replace(FORBIDDEN_ELEMENT_RE, '');

    // Strip event handler attributes anywhere they appear.
    working = working.replace(EVENT_HANDLER_ATTR_RE, '');

    // Strip xlink:href / href attributes — inline icons should not need
    // them, and they're the most common SVG XSS vector.
    working = working.replace(DANGEROUS_HREF_RE, '');

    // Strip inline style attributes — they can pull in url(javascript:…).
    working = working.replace(STYLE_ATTR_RE, '');

    // After scrubbing, double-check no dangerous URL scheme leaked
    // through (e.g. inside fill="url(javascript:…)" — paranoid belt).
    if (DANGEROUS_URL_VALUE_RE.test(working)) {
        return { ok: false, reason: 'dangerous-content' };
    }

    // Reject external paint-server references — `url(https://…)` etc.
    // would fetch from an arbitrary host when the SVG renders inline and
    // leak the viewer's IP. Local `url(#id)` fragment refs are fine.
    if (EXTERNAL_URL_REF_RE.test(working)) {
        return { ok: false, reason: 'dangerous-content' };
    }

    // Must be a single <svg>…</svg> root.
    const openMatch = working.match(SVG_OPEN_TAG_RE);
    if (!openMatch) {
        return { ok: false, reason: 'no-svg-tag' };
    }

    const closeIndex = working.toLowerCase().lastIndexOf('</svg>');
    if (closeIndex === -1) {
        return { ok: false, reason: 'unclosed-svg' };
    }

    // Discard any prose / leading whitespace the model might have
    // emitted before the opening <svg>, and anything trailing after
    // </svg>.
    const startIndex = working.toLowerCase().indexOf('<svg');
    working = working.slice(startIndex, closeIndex + '</svg>'.length);

    // Re-run the open-tag match against the trimmed string so the
    // captured attributes reflect the actual root element.
    const trimmedOpen = working.match(SVG_OPEN_TAG_RE);
    if (!trimmedOpen) {
        return { ok: false, reason: 'no-svg-tag' };
    }

    const normalizedAttrs = normalizeRootAttrs(trimmedOpen[1] ?? '');
    working = working.replace(SVG_OPEN_TAG_RE, `<svg${normalizedAttrs}>`);

    // Collapse runs of whitespace — keeps payloads small for YAML.
    working = working.replace(/\s+/g, ' ').replace(/>\s+</g, '><').trim();

    const bytes = Buffer.byteLength(working, 'utf8');
    if (bytes > MAX_SVG_LENGTH) {
        return { ok: false, reason: 'too-large' };
    }

    return { ok: true, svg: working, bytes };
}

/**
 * Strip width/height (we render at the consumer's chosen size), drop
 * any href attrs that survived the body pass, and ensure viewBox and
 * xmlns are present. Returns the new attribute string with a leading
 * space (or empty).
 */
function normalizeRootAttrs(rawAttrs: string): string {
    let attrs = rawAttrs;

    // Strip width/height; consumer renders at desired size.
    attrs = attrs.replace(WIDTH_HEIGHT_ATTR_RE, '');

    // Strip event handlers and href once more in case they were on <svg>.
    attrs = attrs.replace(EVENT_HANDLER_ATTR_RE, '');
    attrs = attrs.replace(DANGEROUS_HREF_RE, '');
    attrs = attrs.replace(STYLE_ATTR_RE, '');

    // Ensure viewBox is present and normalized.
    if (/\bviewBox\s*=\s*/i.test(attrs)) {
        attrs = attrs.replace(
            /\bviewBox\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i,
            `viewBox="${NORMALIZED_VIEWBOX}"`,
        );
    } else {
        attrs = `${attrs} viewBox="${NORMALIZED_VIEWBOX}"`;
    }

    // Ensure xmlns is present so the browser treats the file as SVG.
    if (!/\bxmlns\s*=\s*/i.test(attrs)) {
        attrs = ` xmlns="http://www.w3.org/2000/svg"${attrs}`;
    }

    return attrs.replace(/\s+/g, ' ').trimEnd();
}
