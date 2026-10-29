/**
 * Client-side scrub for an inline SVG icon rendered with `dangerouslySetInnerHTML`
 * (category icons, plugin icons).
 *
 * Defence in depth behind the server sanitizer (`svg-sanitizer.ts` in
 * `@ever-works/agent`): pre-seeded, imported or restored rows can reach the
 * browser without passing through it. Inline icon SVGs never legitimately
 * contain any of the constructs below, so stripping them wholesale is safe for
 * every real icon. Swap for `isomorphic-dompurify` if it is ever added as a web
 * dependency.
 *
 * Fails closed (answers `''`) when:
 *  - the input is longer than any icon (`MAX_INLINE_SVG_LENGTH`), or
 *  - an event-handler-shaped attribute survives the scrub, or
 *  - any element outside the server sanitizer's allow-list is left (an HTML tag,
 *    including inside <title>/<desc>), or a reference to another host, or
 *  - a dangerous URL scheme survives anywhere in the body, or
 *  - the scrub is not a fixed point: if a second pass of a pattern would still remove
 *    something, the first pass spliced a new construct together out of the
 *    leftovers (`<scr<script>ipt>`, `<!<!-- -->-- -->`) — the input was built to
 *    survive one pass, so nothing of it is rendered (CodeQL
 *    js/incomplete-multi-character-sanitization).
 */

// Every element an icon never needs and an attacker can use: script/embedding
// containers, links, CSS, external images and SMIL animation (which can set an
// `href` at runtime). Covers the SVG2 `<use href>` form too.
const SVG_DANGEROUS_TAG_RE =
    /<\/?\s*(?:script|iframe|object|embed|foreignObject|use|a|style|image|set|handler|listener|animate|animateTransform|animateMotion|feImage)\b[^>]*>/gi;
// Whole `<style>…</style>` blocks, so a CSS payload such as
// `*{background:url('javascript:…')}` or `@import` cannot survive as a stylesheet.
const SVG_STYLE_BLOCK_RE = /<\s*style\b[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi;
// Event handlers and href attributes, also when separated by `/`
// (`<svg/onload=…>`) or glued to the previous quoted value
// (`<img src="x"onerror=…>`, which the HTML parser accepts), not only by whitespace.
const SVG_DANGEROUS_ATTR_RE =
    /(?:[\s/]|(?<=["']))(?:on[a-z]+|xlink:href|href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
// Belt and braces after the scrub: any event-handler-shaped attribute left at all.
const SVG_HANDLER_LEFT_RE = /\bon[a-z]+\s*=/i;
/**
 * Twice the server sanitizer's output cap (`MAX_SVG_LENGTH`, 4000): no real icon is
 * longer, and it bounds the tag patterns' work on hostile input in the viewer's browser.
 */
export const MAX_INLINE_SVG_LENGTH = 8000;
/**
 * The only elements an icon may contain, lowercased: the server sanitizer's
 * `ALLOWED_ELEMENTS` (`svg-sanitizer.ts`). The output is set with innerHTML, so the
 * HTML parser reads it: an HTML tag inside <svg> (<img>, <p>, …) leaves SVG and becomes
 * a live HTML element, and <title>/<desc> parse their content as HTML. A deny-list can
 * never name every such tag, so anything not listed fails the icon.
 */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
    'svg', 'g', 'defs', 'symbol', 'title', 'desc', 'path', 'circle', 'ellipse', 'line',
    'polyline', 'polygon', 'rect', 'text', 'tspan', 'a', 'lineargradient',
    'radialgradient', 'stop', 'clippath', 'mask', 'pattern', 'marker',
]);
// Every tag the HTML tokenizer opens or closes: `<` or `</`, an ASCII letter, a name.
const TAG_NAME_RE = /<\/?([a-z][^\s/>]*)/gi;
// A paint server or other reference to another host (`url(https://…)`, `url(//…)`):
// rendering it would make every viewer's browser contact that host.
const EXTERNAL_URL_REF_RE = /url\s*\(\s*(?:['"]\s*)?(?:[a-z][a-z0-9+.-]*:)?\/\//i;

function hasForeignElement(svg: string): boolean {
    for (const [, name] of svg.matchAll(TAG_NAME_RE)) {
        if (!ALLOWED_ELEMENTS.has(name.toLowerCase())) return true;
    }
    return false;
}
// A dangerous URL scheme anywhere in the body, after the scrub.
const SVG_DANGEROUS_URL_RE = /\b(?:javascript|vbscript|data|file)\s*:/i;

// The scrub, in order. Each pattern only removes text.
const SCRUB_PATTERNS: readonly RegExp[] = [
    // XML processing instructions / DOCTYPE do not belong inline.
    /<\?xml[^>]*\?>/gi,
    /<!DOCTYPE[^>]*>/gi,
    // Comments / CDATA, so payloads cannot hide inside them.
    /<!--[\s\S]*?-->/g,
    /<!\[CDATA\[[\s\S]*?\]\]>/g,
    SVG_STYLE_BLOCK_RE,
    SVG_DANGEROUS_TAG_RE,
    SVG_DANGEROUS_ATTR_RE,
];

/**
 * `input.replace(pattern, '')` until nothing changes (the shape CodeQL
 * js/incomplete-multi-character-sanitization recognises), counting the passes that
 * removed something. Every pass shortens the text and the input is capped, so it ends.
 */
function stripUntilStable(input: string, pattern: RegExp): { text: string; rounds: number } {
    let rounds = 0;
    let previous: string;
    let current = input;
    do {
        previous = current;
        current = current.replace(pattern, '');
        if (current !== previous) rounds += 1;
    } while (current !== previous);
    return { text: current, rounds };
}

export function sanitizeInlineSvg(svg: string | null | undefined): string {
    if (typeof svg !== 'string' || svg.length > MAX_INLINE_SVG_LENGTH) return '';
    let cleaned = svg;
    for (const pattern of SCRUB_PATTERNS) {
        const pass = stripUntilStable(cleaned, pattern);
        // A second removing pass means the first spliced a construct together out of the
        // leftovers: the input was built to survive one pass, so none of it is rendered.
        if (pass.rounds > 1) return '';
        cleaned = pass.text;
    }
    // A later pattern's removal can splice an earlier pattern's construct together, so the
    // result must already be clean for every pattern.
    if (SCRUB_PATTERNS.some((pattern) => cleaned.replace(pattern, '') !== cleaned)) return '';
    if (
        SVG_DANGEROUS_URL_RE.test(cleaned) ||
        SVG_HANDLER_LEFT_RE.test(cleaned) ||
        EXTERNAL_URL_REF_RE.test(cleaned) ||
        hasForeignElement(cleaned)
    ) {
        return '';
    }
    return cleaned;
}
