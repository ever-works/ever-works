import { MAX_SVG_LENGTH, sanitizeSvg } from '../svg-sanitizer';

describe('sanitizeSvg', () => {
    describe('rejection', () => {
        it.each<[string, unknown]>([
            ['null input', null],
            ['undefined input', undefined],
            ['empty string', ''],
            ['whitespace only', '   \n  '],
            ['non-string input', 123],
        ])('rejects %s', (_, input) => {
            const result = sanitizeSvg(input as string);
            expect(result.ok).toBe(false);
            if (result.ok === false) {
                expect(result.reason).toBe('empty');
            }
        });

        it('rejects markup with no <svg> root', () => {
            const result = sanitizeSvg('<div>not an svg</div>');
            expect(result.ok).toBe(false);
            if (result.ok === false) {
                expect(result.reason).toBe('no-svg-tag');
            }
        });

        it('rejects an unclosed <svg>', () => {
            const result = sanitizeSvg('<svg viewBox="0 0 24 24"><circle/>');
            expect(result.ok).toBe(false);
            if (result.ok === false) {
                expect(result.reason).toBe('unclosed-svg');
            }
        });

        it('rejects payloads exceeding MAX_SVG_LENGTH', () => {
            const filler = '<path d="M0 0L1 1"/>'.repeat(500);
            const oversize = `<svg viewBox="0 0 24 24">${filler}</svg>`;
            expect(oversize.length).toBeGreaterThan(MAX_SVG_LENGTH);

            const result = sanitizeSvg(oversize);
            expect(result.ok).toBe(false);
            if (result.ok === false) {
                expect(result.reason).toBe('too-large');
            }
        });
    });

    describe('scrubbing', () => {
        it('strips <script> blocks', () => {
            const input =
                '<svg viewBox="0 0 24 24"><script>alert(1)</script><circle cx="12" cy="12" r="6"/></svg>';
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg).not.toContain('script');
                expect(result.svg).not.toContain('alert');
                expect(result.svg).toContain('<circle');
            }
        });

        it('strips <foreignObject> blocks', () => {
            const input =
                '<svg viewBox="0 0 24 24"><foreignObject><div onclick="x()"></div></foreignObject><circle cx="12" cy="12" r="6"/></svg>';
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg).not.toContain('foreignObject');
                expect(result.svg).not.toContain('onclick');
                expect(result.svg).toContain('<circle');
            }
        });

        it('strips event handler attributes (on*)', () => {
            const input =
                '<svg viewBox="0 0 24 24"><circle onload="evil()" onclick="evil()" cx="12" cy="12" r="6"/></svg>';
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg).not.toMatch(/\bonload=/i);
                expect(result.svg).not.toMatch(/\bonclick=/i);
                expect(result.svg).not.toContain('evil');
            }
        });

        it('strips xlink:href and href attributes', () => {
            const input =
                '<svg viewBox="0 0 24 24"><a href="https://evil.example.com"><circle xlink:href="#bad" cx="12" cy="12" r="6"/></a></svg>';
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg).not.toMatch(/\bhref=/i);
                expect(result.svg).not.toMatch(/\bxlink:href=/i);
            }
        });

        it('rejects payloads containing javascript:/data:/vbscript: URL schemes that survive scrubbing', () => {
            // The href stripper removes most vectors; this construct hides one
            // inside fill="url(...)".
            const input =
                '<svg viewBox="0 0 24 24"><circle fill="url(javascript:alert(1))" cx="12" cy="12" r="6"/></svg>';
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(false);
            if (result.ok === false) {
                expect(result.reason).toBe('dangerous-content');
            }
        });

        it('detects a dangerous URL on every call (regression: stateful /g regex bypass)', () => {
            // Greptile P1: when DANGEROUS_URL_VALUE_RE was declared with the `g`
            // flag, RegExp.prototype.test() retained `lastIndex` across calls.
            // After a successful match at offset N, the next call starts
            // searching from N — and any payload whose `javascript:` appears
            // before that offset returned `false`, silently bypassing the check.
            // This test calls sanitizeSvg with two different payloads in
            // succession and asserts both are rejected.
            const padded = `<svg viewBox="0 0 24 24"><circle fill="url(javascript:alert(1))" cx="12" cy="12" r="6" data-pad="${'x'.repeat(60)}"/></svg>`;
            const compact =
                '<svg viewBox="0 0 24 24"><circle fill="url(javascript:alert(2))" cx="12" cy="12" r="6"/></svg>';

            const first = sanitizeSvg(padded);
            const second = sanitizeSvg(compact);
            const third = sanitizeSvg(compact);

            for (const result of [first, second, third]) {
                expect(result.ok).toBe(false);
                if (result.ok === false) {
                    expect(result.reason).toBe('dangerous-content');
                }
            }
        });

        it.each<[string, string]>([
            [
                'http://… in fill',
                '<svg viewBox="0 0 24 24"><circle fill="url(http://tracker.example/pixel.svg#g)" cx="12" cy="12" r="6"/></svg>',
            ],
            [
                'https://… in fill',
                '<svg viewBox="0 0 24 24"><rect fill="url(https://tracker.example/pixel)" width="24" height="24"/></svg>',
            ],
            [
                'protocol-relative // in stroke',
                '<svg viewBox="0 0 24 24"><circle stroke="url(//tracker.example/pixel)" cx="12" cy="12" r="6"/></svg>',
            ],
        ])('rejects external paint-server reference (%s) — IP-leak vector', (_, input) => {
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(false);
            if (result.ok === false) {
                expect(result.reason).toBe('dangerous-content');
            }
        });

        it('allows local fragment paint refs like url(#myGradient)', () => {
            const input =
                '<svg viewBox="0 0 24 24"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><circle fill="url(#g)" cx="12" cy="12" r="6"/></svg>';
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg).toContain('url(#g)');
            }
        });

        it('strips comments, DOCTYPE, processing instructions, and CDATA', () => {
            const input =
                '<?xml version="1.0"?><!DOCTYPE svg><svg viewBox="0 0 24 24"><!-- payload --><![CDATA[stuff]]><circle cx="12" cy="12" r="6"/></svg>';
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg).not.toContain('<!--');
                expect(result.svg).not.toContain('DOCTYPE');
                expect(result.svg).not.toContain('CDATA');
                expect(result.svg).not.toContain('<?xml');
            }
        });
    });

    describe('normalization', () => {
        it('forces viewBox to "0 0 24 24"', () => {
            const input = '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40"/></svg>';
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg).toContain('viewBox="0 0 24 24"');
                expect(result.svg).not.toContain('0 0 100 100');
            }
        });

        it('adds viewBox when missing', () => {
            const input = '<svg><circle cx="12" cy="12" r="6"/></svg>';
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg).toContain('viewBox="0 0 24 24"');
            }
        });

        it('strips width and height attributes from the root', () => {
            const input =
                '<svg width="48" height="48" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>';
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg).not.toMatch(/\bwidth=/);
                expect(result.svg).not.toMatch(/\bheight=/);
            }
        });

        it('ensures xmlns is present', () => {
            const input = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>';
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
            }
        });

        it('discards content outside the <svg>...</svg> root', () => {
            const input =
                'Sure, here is your icon:\n<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>\nLet me know if you need adjustments.';
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg.startsWith('<svg')).toBe(true);
                expect(result.svg.endsWith('</svg>')).toBe(true);
                expect(result.svg).not.toContain('Sure');
                expect(result.svg).not.toContain('Let me know');
            }
        });
    });

    describe('happy path', () => {
        it('passes a clean curated icon through unchanged in spirit', () => {
            const input =
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>';
            const result = sanitizeSvg(input);
            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg).toContain('<circle');
                expect(result.svg).toContain('viewBox="0 0 24 24"');
                expect(result.svg).toContain('stroke="currentColor"');
                expect(result.bytes).toBeGreaterThan(0);
                expect(result.bytes).toBeLessThanOrEqual(MAX_SVG_LENGTH);
            }
        });
    });
});
