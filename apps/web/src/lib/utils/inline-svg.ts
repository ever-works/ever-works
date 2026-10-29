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
 *  - a dangerous URL scheme survives anywhere in the body, or
 *  - the scrub is not a fixed point: if a second pass would still remove
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
// A dangerous URL scheme anywhere in the body, after the scrub.
const SVG_DANGEROUS_URL_RE = /\b(?:javascript|vbscript|data|file)\s*:/i;

export function sanitizeInlineSvg(svg: string | null | undefined): string {
    if (typeof svg !== 'string' || svg.length > MAX_INLINE_SVG_LENGTH) return '';
    // Scrub until stable. Every step only removes text, so a pass that changes nothing
    // means no pattern matches at all; a SECOND pass that still changes something means
    // the first spliced a construct together, and the input is refused.
    let cleaned = svg;
    let previous: string;
    let changingPasses = 0;
    do {
        previous = cleaned;
        // The whole scrub, inline in the loop (the until-stable shape CodeQL
        // js/incomplete-multi-character-sanitization recognises).
        cleaned = cleaned
            // XML processing instructions / DOCTYPE do not belong inline.
            .replace(/<\?xml[^>]*\?>/gi, '')
            .replace(/<!DOCTYPE[^>]*>/gi, '')
            // Comments / CDATA, so payloads cannot hide inside them.
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
            .replace(SVG_STYLE_BLOCK_RE, '')
            .replace(SVG_DANGEROUS_TAG_RE, '')
            .replace(SVG_DANGEROUS_ATTR_RE, '');
        if (cleaned !== previous) changingPasses += 1;
        if (changingPasses > 1) return '';
    } while (cleaned !== previous);
    if (SVG_DANGEROUS_URL_RE.test(cleaned) || SVG_HANDLER_LEFT_RE.test(cleaned)) return '';
    return cleaned;
}
