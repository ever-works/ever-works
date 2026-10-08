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
 *     <embed>, <object>, <animate*>, <set>, <handler>, <listener>, <use>.
 *   - Forbidden attributes removed: on* event handlers, xlink:href/href
 *     (the most common SVG XSS vector), inline style (can carry
 *     url(javascript:…)).
 *   - URL schemes rejected anywhere in the body: javascript:, data:,
 *     vbscript:, file:.
 *   - External paint-server references rejected: any `url(<scheme>://…)`
 *     in fill/stroke/filter/etc. would otherwise leak the viewer's IP to
 *     an arbitrary host as a tracking pixel.
 *   - viewBox normalized to "0 0 24 24"; width/height attrs stripped.
 *   - The finished string is checked, not trusted: an element outside the
 *     SVG allow-list (ALLOWED_ELEMENTS) or an on* / href / style attribute
 *     in ANY position the HTML tokenizer accepts — after whitespace, after
 *     `/`, straight after a quoted value — fails the icon as
 *     dangerous-content. The removal passes above only see the whitespace
 *     form, and innerHTML turns an <img> inside <svg> into a live HTML
 *     element.
 *   - Total length capped at MAX_SVG_LENGTH bytes (matches the DTO cap).
 *   - Input longer than MAX_SVG_INPUT_LENGTH refused before any pass runs.
 *
 * The sanitizer is intentionally regex-based to keep the agent package
 * free of jsdom / DOMPurify (heavy server-side deps). For the trust
 * profile above, conservative regex passes that reject anything they
 * can't fully parse are sufficient.
 *
 * Work is bounded, because the input is hostile by assumption (CodeQL
 * js/polynomial-redos). The comment / DOCTYPE / PI / CDATA passes are linear
 * scans ({@link stripDelimitedBlocks}) — as regexes they retried from every
 * unterminated opener, seconds for a few hundred KB. The attribute passes only
 * start at the first character of a whitespace run (`(?<!\s)`), which makes
 * them linear too, as are EXTERNAL_URL_REF_RE and the final allow-list scan.
 * What remains polynomial on paper — FORBIDDEN_ELEMENT_RE on an unclosed
 * forbidden element, SVG_OPEN_TAG_RE on `<svg` with no `>` — runs on at most
 * MAX_SVG_INPUT_LENGTH characters: under 20 ms on a dev box.
 */

export const MAX_SVG_LENGTH = 4000;

/**
 * The longest input the sanitizer scrubs: twice the output cap, so every
 * DTO-capped paste (MAX_SVG_LENGTH) and any icon-sized model reply — pretty
 * printed, with a line of prose around it — still gets through, while a
 * reply that could never shrink to an icon is refused as `too-large` up front.
 */
export const MAX_SVG_INPUT_LENGTH = 2 * MAX_SVG_LENGTH;

/**
 * Markup constructs dropped before any structural check, in this order: each
 * opener through the first closer after it. Same spans as the regexes they
 * replace (`<!--[\s\S]*?-->`, `<!DOCTYPE[\s\S]*?>` case-insensitively,
 * `<\?[\s\S]*?\?>`, `<!\[CDATA\[[\s\S]*?\]\]>`), found in linear time.
 */
const STRIPPED_BLOCKS: ReadonlyArray<{ readonly opener: RegExp; readonly closer: string }> = [
    { opener: /<!--/g, closer: '-->' },
    { opener: /<!DOCTYPE/gi, closer: '>' },
    { opener: /<\?/g, closer: '?>' },
    { opener: /<!\[CDATA\[/g, closer: ']]>' },
];

// Match paired or self-closing forbidden elements. The non-capturing
// group has two arms: self-close (`<script/>`) or full pair
// (`<script ...>body</script>`). Without the explicit `>` after the
// attribute capture, a non-greedy body match would terminate at the
// opening `>` and leave the body intact — which is exactly what we
// were trying to remove.
// Security: `use` is also forbidden — inline category icons have no need for
// it, and even with href/xlink:href stripped, a bare <use> can still be
// exploited via browser SVG quirks (filter/feImage chains). Blocking the
// element server-side is the safest and simplest defence.
const FORBIDDEN_ELEMENT_RE =
    /<\s*(script|foreignObject|iframe|embed|object|animate|animateTransform|set|handler|listener|use)\b[^>]*(?:\/>|>[\s\S]*?<\/\s*\1\s*>)/gi;

// The attribute passes each start with the whitespace before the attribute.
// `(?<!\s)` lets a match start only where a whitespace run starts: every other
// offset in the run would reach the same text after it and fail or succeed the
// same way, so the matches are unchanged — but a long run is scanned once, not
// once per offset.
const EVENT_HANDLER_ATTR_RE = /(?<!\s)\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const DANGEROUS_HREF_RE = /(?<!\s)\s+(?:xlink:href|href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const STYLE_ATTR_RE = /(?<!\s)\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const WIDTH_HEIGHT_ATTR_RE = /(?<!\s)\s+(?:width|height)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

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
// Written as `\s*(?:['"]\s*)?` rather than `\s*['"]?\s*`: the same language,
// but a whitespace run can no longer be split between two `\s*` in every
// possible way (CodeQL js/polynomial-redos), so a match attempt is linear.
const EXTERNAL_URL_REF_RE = /url\s*\(\s*(?:['"]\s*)?(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/**
 * The only elements an icon may contain, lowercased. The output is set with
 * innerHTML, so the HTML parser reads it: there an HTML tag inside <svg>
 * (<img>, <p>, <font>, …) leaves SVG and becomes a live HTML element, and
 * <title>/<desc> parse their content as HTML. A deny-list can never name
 * every such tag, so anything not listed here fails the icon.
 */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
    'svg',
    'g',
    'defs',
    'symbol',
    'title',
    'desc',
    'path',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
    'rect',
    'text',
    'tspan',
    'a',
    'lineargradient',
    'radialgradient',
    'stop',
    'clippath',
    'mask',
    'pattern',
    'marker',
]);

// Every tag the HTML tokenizer opens or closes starts `<` or `</` and an ASCII
// letter; its name runs to whitespace, `/` or `>`. `\s` is a superset of the
// tokenizer's whitespace, so a name read here is the tokenizer's name or a
// prefix of it, never a longer one.
const TAG_NAME_RE = /<\/?([a-z][^\s/>]*)/gi;

// An attribute the scrubbing passes exist to remove, wherever the HTML
// tokenizer starts an attribute: after whitespace, after `/`, or straight after
// a quoted value. The passes only see the whitespace form, and removing one
// attribute can glue the text around it into another (`o onload="x"nload=`),
// so the output is checked rather than trusted. No `g` flag (see
// DANGEROUS_URL_VALUE_RE).
const LIVE_ATTRIBUTE_RE = /[\s/"'](?:on[a-z]+|(?:xlink:)?href|style)\s*=/i;

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

    // Bound the work before any pass runs (see MAX_SVG_INPUT_LENGTH).
    if (working.length > MAX_SVG_INPUT_LENGTH) {
        return { ok: false, reason: 'too-large' };
    }

    // Drop comments / DOCTYPE / PIs / CDATA before any structural checks
    // so attackers can't hide payloads inside them.
    for (const { opener, closer } of STRIPPED_BLOCKS) {
        working = stripDelimitedBlocks(working, opener, closer);
    }

    // Strip forbidden elements wholesale (both paired and self-closing).
    working = working.replace(FORBIDDEN_ELEMENT_RE, '');

    // Strip event handler attributes anywhere they appear. A handler that only
    // appears once another is stripped was built to slip past the scrub: fail
    // closed rather than trust the rewrite.
    const handlerFree = stripUntilStable(working, EVENT_HANDLER_ATTR_RE);
    if (handlerFree.rounds > 1) {
        return { ok: false, reason: 'dangerous-content' };
    }
    working = handlerFree.text;

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

    // Fail closed on what the passes above could not remove: this exact
    // string is what the browser parses.
    if (hasLiveMarkup(working)) {
        return { ok: false, reason: 'dangerous-content' };
    }

    const bytes = Buffer.byteLength(working, 'utf8');
    if (bytes > MAX_SVG_LENGTH) {
        return { ok: false, reason: 'too-large' };
    }

    return { ok: true, svg: working, bytes };
}

/**
 * True when `svg` still carries an element outside {@link ALLOWED_ELEMENTS} or
 * an event handler / href / style attribute in any position the HTML tokenizer
 * reads as an attribute. Both scans are linear.
 */
function hasLiveMarkup(svg: string): boolean {
    if (LIVE_ATTRIBUTE_RE.test(svg)) {
        return true;
    }
    for (const [, name] of svg.matchAll(TAG_NAME_RE)) {
        if (!ALLOWED_ELEMENTS.has(name.toLowerCase())) {
            return true;
        }
    }
    return false;
}

/**
 * Apply `pattern` (a global regex) until the text stops changing, so a removal
 * cannot splice the leftovers into a new match — e.g. `<path o onx="1"nclick="y">`
 * would leave `<path onclick="y">` after one pass (CodeQL
 * js/incomplete-multi-character-sanitization). Every pass shortens the text,
 * and the input is capped at {@link MAX_SVG_INPUT_LENGTH}, so this terminates.
 * `rounds` counts the passes that removed something: more than one means the
 * input was built to survive a single pass.
 */
function stripUntilStable(input: string, pattern: RegExp): { text: string; rounds: number } {
    let rounds = 0;
    let previous: string;
    let current = input;
    do {
        previous = current;
        current = current.replace(pattern, '');
        if (current !== previous) {
            rounds += 1;
        }
    } while (current !== previous);
    return { text: current, rounds };
}

/**
 * Remove every `opener … closer` span from `input` — each opener through the
 * first `closer` that starts after it — scanning left to right, in linear time.
 * The same spans `input.replace(/<opener>[\s\S]*?<closer>/g, '')` removes: an
 * opener with no closer after it is left in place, and then so is everything
 * after it, because no later opener can have a closer either.
 */
function stripDelimitedBlocks(input: string, opener: RegExp, closer: string): string {
    // A fresh global copy: `lastIndex` is per-call state, never shared.
    const open = new RegExp(
        opener.source,
        opener.flags.includes('g') ? opener.flags : `${opener.flags}g`,
    );
    let stripped = '';
    let cursor = 0;
    for (;;) {
        open.lastIndex = cursor;
        const found = open.exec(input);
        if (!found) break;
        const end = input.indexOf(closer, found.index + found[0].length);
        if (end === -1) break;
        stripped += input.slice(cursor, found.index);
        cursor = end + closer.length;
    }
    return cursor === 0 ? input : stripped + input.slice(cursor);
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
    attrs = stripUntilStable(attrs, EVENT_HANDLER_ATTR_RE).text;
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
