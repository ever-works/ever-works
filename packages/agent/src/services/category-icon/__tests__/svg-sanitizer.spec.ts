import { MAX_SVG_INPUT_LENGTH, MAX_SVG_LENGTH, sanitizeSvg } from '../svg-sanitizer';

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

        it('fails closed on a handler that one removal pass would splice together on the root', () => {
            const result = sanitizeSvg(
                '<svg o onx="1"nclick="evil()" viewBox="0 0 24 24"><path d="M0 0"/></svg>',
            );

            expect(result).toEqual({ ok: false, reason: 'dangerous-content' });
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

        // The output is set with innerHTML, so it is parsed by the HTML5
        // algorithm, not as XML. There an attribute may also follow a `/` or a
        // closing quote directly, and an HTML tag such as <img> inside <svg>
        // leaves SVG and becomes a live HTML element. Each payload below came
        // back ok:true. Parsed by parse5 (the browsers' algorithm), the first
        // six give a live event handler or a javascript: href, and the two
        // after them an HTML-namespace <img>.
        it.each<[string, string]>([
            [
                'an <img> breakout whose handler follows a closing double quote',
                '<svg viewBox="0 0 24 24"><path d="M0 0"/><img src="x"onerror=alert(document.domain)></svg>',
            ],
            [
                'an <img> breakout whose handler follows a closing single quote',
                "<svg viewBox='0 0 24 24'><path d='M0 0'/><img src='x'onerror=alert(1)></svg>",
            ],
            [
                'a root handler that follows a slash',
                '<svg xmlns="http://www.w3.org/2000/svg"/onload=alert(1)><path d="M0 0"/></svg>',
            ],
            [
                'a child handler that follows a slash',
                '<svg viewBox="0 0 24 24"><path d="M0 0"/onmouseover=alert(1) /></svg>',
            ],
            [
                'a handler rebuilt by stripping the one inside it',
                '<svg viewBox="0 0 24 24"><circle o onload="x"nload=alert(1) r="1"/></svg>',
            ],
            [
                'an entity-encoded javascript: href that follows a slash',
                '<svg viewBox="0 0 24 24"><a/href="jav&#x61;script:alert(1)"><circle r="1"/></a></svg>',
            ],
            [
                'an HTML element that leaves SVG, even without a handler',
                '<svg viewBox="0 0 24 24"><circle r="1"/><img src="x"></svg>',
            ],
            [
                'an HTML element inside an SVG <title> (an HTML integration point)',
                '<svg viewBox="0 0 24 24"><title><img src=x onerror=alert(1)></title><circle r="1"/></svg>',
            ],
            [
                'a forbidden element that is never closed',
                '<svg viewBox="0 0 24 24"><circle r="1"/><script>alert(1)</svg>',
            ],
            [
                'inline style that follows a closing quote',
                '<svg viewBox="0 0 24 24"><circle r="1"style="fill:url(#a)"/></svg>',
            ],
        ])('fails closed on %s', (_, input) => {
            const result = sanitizeSvg(input);

            expect(result).toEqual({ ok: false, reason: 'dangerous-content' });
        });

        it('keeps the SVG elements an icon uses, and strips a spaced handler as before', () => {
            const input =
                '<svg viewBox="0 0 24 24"><title>Box</title><desc>d</desc><defs><linearGradient id="g"><stop offset="0"/></linearGradient><radialGradient id="r"/><clipPath id="c"><rect width="1" height="1"/></clipPath><mask id="m"/><pattern id="p"/><marker id="k"/><symbol id="s"/></defs><g clip-path="url(#c)"><path d="M0 0"/><circle r="1"/><ellipse rx="1" ry="1"/><line x2="1"/><polyline points="0 0"/><polygon points="0 0"/><rect width="1" height="1"/><text>t<tspan>u</tspan></text><a><circle r="2" onclick="x()"/></a><svg/></g></svg>';

            const result = sanitizeSvg(input);

            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg).toContain('<linearGradient id="g">');
                expect(result.svg).toContain('<a><circle r="2"/></a>');
                expect(result.svg).not.toContain('onclick');
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

    // CodeQL js/polynomial-redos: the scrubbing passes used to be regexes that
    // retry from every offset of an unterminated construct, so a hostile icon
    // (a pasted SVG, or model output steered by a category name) cost time
    // quadratic in its length — about 5 s for 200 KB of `<!--` on a dev box.
    describe('bounded work on hostile input', () => {
        const elapsedMs = (run: () => void): number => {
            const started = performance.now();
            run();
            return performance.now() - started;
        };

        it.each<[string, string]>([
            ['an unterminated comment', '<!--'],
            ['an unterminated DOCTYPE', '<!DOCTYPE'],
            ['an unterminated processing instruction', '<?'],
            ['an unterminated CDATA section', '<![CDATA['],
            ['an unclosed forbidden element', '<script'],
            ['a whitespace run before a non-attribute', ' '],
        ])('answers for %s repeated 50,000 times in well under 200 ms', (_, unit) => {
            // After the root, so nothing later closes the construct.
            const input = `<svg viewBox="0 0 24 24"><circle r="1"/></svg>${unit.repeat(50_000)}x`;
            let result: ReturnType<typeof sanitizeSvg> | undefined;

            expect(elapsedMs(() => (result = sanitizeSvg(input)))).toBeLessThan(200);
            expect(result?.ok).toBe(false);
        });

        // `url\s*\(\s*['"]?\s*` could split a whitespace run between its two
        // `\s*` in many ways: about 85 ms (warm) for one `url(` and a run up
        // to the input cap, the slowest pass left. Warm the path first so the
        // budget measures the pattern, not the first call.
        it('answers a url( followed by a whitespace run at the input cap in a few milliseconds', () => {
            const input = `<svg viewBox="0 0 24 24"><circle r="1"/></svg>url(${' '.repeat(
                MAX_SVG_INPUT_LENGTH - 60,
            )}x`;
            expect(input.length).toBeLessThanOrEqual(MAX_SVG_INPUT_LENGTH);
            sanitizeSvg(input);

            let result: ReturnType<typeof sanitizeSvg> | undefined;
            expect(elapsedMs(() => (result = sanitizeSvg(input)))).toBeLessThan(40);
            expect(result?.ok).toBe(true);
        });

        it.each<[string, boolean]>([
            ['url(//h/p)', true],
            ['url( "https://h/p" )', true],
            ["url(' \t//h')", true],
            ['URL (\n x-y.z+1://h)', true],
            ['url(#g)', false],
            ['url("#g")', false],
            ['url( http:/h)', false],
            ['url(""//h)', false],
            ['url(1x://h)', false],
        ])('flags the external paint reference in %p exactly as before', (ref, external) => {
            const result = sanitizeSvg(`<svg viewBox="0 0 24 24"><text>${ref}</text></svg>`);

            expect(result.ok).toBe(!external);
        });

        it('rejects an input far larger than any icon as too-large before scrubbing it', () => {
            const input = `<svg viewBox="0 0 24 24"><circle r="1"/><!--${'x'.repeat(
                4 * MAX_SVG_LENGTH,
            )}--></svg>`;

            const result = sanitizeSvg(input);

            expect(result.ok).toBe(false);
            if (result.ok === false) {
                expect(result.reason).toBe('too-large');
            }
        });

        it('still scrubs an input that shrinks below MAX_SVG_LENGTH once comments are gone', () => {
            const input = `<svg viewBox="0 0 24 24"><!--${'x'.repeat(
                MAX_SVG_LENGTH,
            )}--><circle r="1"/></svg>`;
            expect(input.length).toBeGreaterThan(MAX_SVG_LENGTH);

            const result = sanitizeSvg(input);

            expect(result).toEqual({
                ok: true,
                svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="1"/></svg>',
                bytes: 81,
            });
        });

        // Golden outputs recorded from the regex implementation this replaced:
        // the linear passes must scrub exactly the same spans, edge cases
        // (overlapping `<!-->`, nesting, unterminated openers, pass order,
        // whitespace runs around stripped attributes) included.
        it.each<[string, string]>([
            [
                '<svg viewBox="0 0 24 24"><!--><circle r="1"/>--><path d="M1 1"/></svg>',
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1"/></svg>',
            ],
            [
                '<svg viewBox="0 0 24 24"><circle r="1"/><!-- never closed</svg>',
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="1"/><!-- never closed</svg>',
            ],
            [
                '<svg><!-- a <!-- b --> c --><circle r="1"/></svg>',
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"> c --><circle r="1"/></svg>',
            ],
            [
                '<!doctype svg PUBLIC "x"><svg><circle r="1"/></svg>',
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="1"/></svg>',
            ],
            [
                '<svg><?pi data?><circle r="1"/><?unterminated</svg>',
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="1"/><?unterminated</svg>',
            ],
            [
                '<svg><![CDATA[ <script>alert(1)</script> ]]><circle r="1"/></svg>',
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="1"/></svg>',
            ],
            [
                '<svg><!-- <![CDATA[ --> ]]><circle r="1"/></svg>',
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"> ]]><circle r="1"/></svg>',
            ],
            [
                '<svg   width="10"    height="10"   viewBox="0 0 1 1"><circle   onclick="x()"   r="1"   style="fill:red"/><a    href="#x">t</a></svg>',
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="1"/><a>t</a></svg>',
            ],
            [
                '<svg\n\twidth="1"\n><circle\n\tonload="x" r="1"/></svg>',
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="1"/></svg>',
            ],
            [
                `<svg><circle r="1"/>${'<!--x-->'.repeat(100)}</svg>`,
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="1"/></svg>',
            ],
            [
                '<svg><circle r="1" data-a="<!DOCTYPE"/><!DoCtYpE x></svg>',
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle r="1" data-a="</svg>',
            ],
        ])('scrubs %p exactly as before', (input, svg) => {
            const result = sanitizeSvg(input);

            expect(result.ok).toBe(true);
            if (result.ok === true) {
                expect(result.svg).toBe(svg);
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
