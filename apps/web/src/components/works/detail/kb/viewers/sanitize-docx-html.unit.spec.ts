import { describe, expect, it } from 'vitest';
import { sanitizeDocxHtml } from './sanitize-docx-html';

/**
 * EW-641 Phase 1B/d row 10 — `sanitizeDocxHtml` is the belt-and-
 * braces guard between mammoth's output and `dangerouslySetInnerHTML`.
 * Mammoth produces tame markup under normal Word documents, but a
 * malicious uploader could embed raw HTML; the sanitiser drops
 * anything outside the allowlist before render.
 */
describe('sanitizeDocxHtml', () => {
    it('preserves allowlisted block + inline elements', () => {
        const html =
            '<h2>Title</h2><p>Body with <strong>bold</strong> and <em>italic</em>.</p>' +
            '<ul><li>One</li><li>Two</li></ul>';
        expect(sanitizeDocxHtml(html)).toBe(html);
    });

    it('strips <script> elements entirely', () => {
        const out = sanitizeDocxHtml('<p>Hi</p><script>alert(1)</script><p>Bye</p>');
        expect(out).toBe('<p>Hi</p><p>Bye</p>');
        expect(out).not.toContain('alert');
    });

    it('strips <iframe> / <object> / <embed>', () => {
        const out = sanitizeDocxHtml(
            '<p>x</p><iframe src="https://evil"></iframe><object data="x"></object><embed src="x">',
        );
        expect(out).toBe('<p>x</p>');
    });

    it('strips on* event handler attributes', () => {
        const out = sanitizeDocxHtml('<p onclick="alert(1)" onmouseover="evil()">x</p>');
        expect(out).toBe('<p>x</p>');
    });

    it('drops javascript: hrefs but keeps safe https links + adds rel/target', () => {
        const out = sanitizeDocxHtml(
            '<a href="javascript:alert(1)">bad</a><a href="https://example.com">good</a>',
        );
        // Bad link keeps text but loses href.
        expect(out).toContain('<a>bad</a>');
        // Good link gains noopener/noreferrer + target=_blank.
        expect(out).toContain('href="https://example.com"');
        expect(out).toContain('rel="noopener noreferrer"');
        expect(out).toContain('target="_blank"');
    });

    it('allows mailto: and relative URLs', () => {
        const out = sanitizeDocxHtml('<a href="mailto:x@y.com">e</a><a href="./local">r</a>');
        expect(out).toContain('href="mailto:x@y.com"');
        expect(out).toContain('href="./local"');
    });

    it('drops javascript: img src but keeps data:image/png', () => {
        const out = sanitizeDocxHtml(
            '<img src="javascript:alert(1)"><img src="data:image/png;base64,abc" alt="x">',
        );
        expect(out).not.toContain('javascript:');
        expect(out).toContain('src="data:image/png;base64,abc"');
        expect(out).toContain('alt="x"');
    });

    it('strips style/class attributes that are outside the allowlist', () => {
        const out = sanitizeDocxHtml('<p style="color:red" class="x">hi</p>');
        expect(out).toBe('<p>hi</p>');
    });

    it('preserves tables with allowlisted colspan/rowspan attrs', () => {
        const html =
            '<table><thead><tr><th colspan="2">H</th></tr></thead>' +
            '<tbody><tr><td>a</td><td>b</td></tr></tbody></table>';
        expect(sanitizeDocxHtml(html)).toBe(html);
    });

    it('returns empty string for empty / null input', () => {
        expect(sanitizeDocxHtml('')).toBe('');
        expect(sanitizeDocxHtml(null as unknown as string)).toBe('');
    });

    it('recursively prunes nested disallowed elements', () => {
        const out = sanitizeDocxHtml(
            '<div><p>ok<script>x</script><span onclick="bad()">span</span></p></div>',
        );
        expect(out).toBe('<div><p>ok<span>span</span></p></div>');
    });
});
