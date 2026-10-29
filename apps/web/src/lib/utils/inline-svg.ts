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
// (`<svg/onload=…>`), not only by whitespace.
const SVG_DANGEROUS_ATTR_RE =
    /[\s/](?:on[a-z]+|xlink:href|href)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
// A dangerous URL scheme anywhere in the body, after the scrub.
const SVG_DANGEROUS_URL_RE = /\b(?:javascript|vbscript|data|file)\s*:/i;

function scrubOnce(svg: string): string {
    return (
        svg
            // XML processing instructions / DOCTYPE do not belong inline.
            .replace(/<\?xml[^>]*\?>/gi, '')
            .replace(/<!DOCTYPE[^>]*>/gi, '')
            // Comments / CDATA, so payloads cannot hide inside them.
            .replace(/<!--[\s\S]*?-->/g, '')
            .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
            .replace(SVG_STYLE_BLOCK_RE, '')
            .replace(SVG_DANGEROUS_TAG_RE, '')
            .replace(SVG_DANGEROUS_ATTR_RE, '')
    );
}

export function sanitizeInlineSvg(svg: string | null | undefined): string {
    if (typeof svg !== 'string') return '';
    const cleaned = scrubOnce(svg);
    // Every step only removes text, so an unchanged second pass means no pattern
    // matches the result at all.
    if (scrubOnce(cleaned) !== cleaned) return '';
    if (SVG_DANGEROUS_URL_RE.test(cleaned)) return '';
    return cleaned;
}
