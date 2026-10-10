import { slugifyText, stripHtmlTags, trimEdgeChars, unSlugifyText } from '../text.utils';

describe('slugifyText', () => {
    it('lowercases and replaces single spaces with dashes', () => {
        expect(slugifyText('Hello World')).toBe('hello-world');
    });

    it('collapses multiple spaces into a single dash', () => {
        expect(slugifyText('Hello   World')).toBe('hello-world');
    });

    it('trims leading and trailing whitespace before slugifying', () => {
        expect(slugifyText('  Hello World  ')).toBe('hello-world');
    });

    it('strips non-word punctuation (anything not [A-Za-z0-9_-])', () => {
        expect(slugifyText('Hello, World!')).toBe('hello-world');
    });

    it('preserves digits and underscores (within \\w character class)', () => {
        expect(slugifyText('Section_1 Hello')).toBe('section_1-hello');
    });

    it('removes accents via NFKD normalisation', () => {
        // 'Café' → 'cafe' after NFKD strip + non-word filter (combining marks
        // are not in \w, so they get dropped by the [^\w-]+ pass).
        expect(slugifyText('Café')).toBe('cafe');
        expect(slugifyText('naïve résumé')).toBe('naive-resume');
    });

    it('collapses runs of dashes from successive special characters', () => {
        // 'a--b' → after replacement chain → single dash. The function applies
        // /--+/g, '-' as the final pass to coalesce runs introduced by stripped
        // non-word characters between word chunks.
        expect(slugifyText('a -- b')).toBe('a-b');
        expect(slugifyText('hello -- world')).toBe('hello-world');
    });

    it('handles an empty string', () => {
        expect(slugifyText('')).toBe('');
    });

    it('handles a string of only special characters', () => {
        expect(slugifyText('!!!@@@###')).toBe('');
    });

    it('handles tab and newline whitespace via \\s+ matcher', () => {
        expect(slugifyText('Hello\tWorld\nFoo')).toBe('hello-world-foo');
    });

    it('preserves underscores between words', () => {
        expect(slugifyText('foo_bar_baz')).toBe('foo_bar_baz');
    });

    it('coerces non-string input via .toString()', () => {
        // toString() chained explicitly inside the function — accepts numbers, etc.
        // Cast to silence TS narrowing while exercising runtime behaviour.
        expect(slugifyText(123 as unknown as string)).toBe('123');
    });
});

describe('unSlugifyText', () => {
    it('replaces dashes with spaces and capitalises each word (Title Case)', () => {
        expect(unSlugifyText('hello-world')).toBe('Hello World');
    });

    it('handles a single token without dashes', () => {
        expect(unSlugifyText('hello')).toBe('Hello');
    });

    it('handles an empty string', () => {
        expect(unSlugifyText('')).toBe('');
    });

    it('lowercases the rest of the word after capitalising the first letter', () => {
        // 'HELLO-WORLD' → 'Hello World'
        expect(unSlugifyText('HELLO-WORLD')).toBe('Hello World');
    });

    it('handles three-segment slugs', () => {
        expect(unSlugifyText('open-source-platform')).toBe('Open Source Platform');
    });

    it('preserves digits inside a word', () => {
        expect(unSlugifyText('section-1-intro')).toBe('Section 1 Intro');
    });

    it('preserves underscores (only dashes are replaced with spaces)', () => {
        expect(unSlugifyText('snake_case-text')).toBe('Snake_case Text');
    });

    it('round-trip slugify→unSlugify on simple ASCII case', () => {
        expect(unSlugifyText(slugifyText('Hello World'))).toBe('Hello World');
    });
});

describe('trimEdgeChars', () => {
    it('strips only the given characters, and only at the edges', () => {
        expect(trimEdgeChars('--a-b--', '-', '-')).toBe('a-b');
        expect(trimEdgeChars('..-slug-.', '.-', '-')).toBe('slug-.');
        expect(trimEdgeChars('keep', '-', '-')).toBe('keep');
    });

    it('returns empty when the whole string is trimmable, without overrunning', () => {
        expect(trimEdgeChars('-----', '-', '-')).toBe('');
        expect(trimEdgeChars('', '-', '-')).toBe('');
    });

    it('matches what the regex trim it replaced produced, including long runs', () => {
        // The pattern it replaced was `/^-+|-+$/g`. V8 answers these edge runs
        // on the first try, so the regex itself is a safe oracle for them; the
        // interior run below is the shape it is quadratic on.
        const cases = ['--a--', '-', '', 'a', '-'.repeat(50_000) + 'a', 'a' + '-'.repeat(50_000)];
        for (const value of cases) {
            expect(trimEdgeChars(value, '-', '-')).toBe(value.replace(/^-+|-+$/g, ''));
        }
    });

    // Sized, not tightly timed: at 200,000 the regex trim needs ~40 s on a dev
    // box (1.7 s at 40,000, quadratic) and the two-pointer scan microseconds,
    // so a 2 s bound can be failed neither by a CPU-throttled CI runner nor
    // passed by the regex. (A "< 200 ms" at 50,000 was one scheduler stall from
    // red — develop CI, 2026-10-09.)
    it('trims around a long interior run in linear time', () => {
        const value = `-a${'-'.repeat(200_000)}b-`;

        const started = performance.now();
        const trimmed = trimEdgeChars(value, '-', '-');
        const elapsedMs = performance.now() - started;

        expect(trimmed).toBe(value.slice(1, -1));
        expect(elapsedMs).toBeLessThan(2_000);
    });
});

describe('stripHtmlTags', () => {
    it.each<[string, string]>([
        ['App <b>Provisioner</b>', 'App Provisioner'],
        ['<<script>x', 'x'],
        ['a <b c="d>">e', 'a ">e'],
        ['keep a < b', 'keep a < b'],
        ['x <y> z <w', 'x  z <w'],
        ['> quote', '> quote'],
        ['<>', ''],
        ['', ''],
    ])('strips %p to %p, as `<[^>]*>` did', (value, stripped) => {
        expect(stripHtmlTags(value)).toBe(stripped);
    });

    // Sized, not tightly timed: at 200,000 unclosed openers `<[^>]*>` needs
    // ~40 s on a dev box and the scan milliseconds, so a 2 s bound can be
    // failed neither by a CPU-throttled CI runner nor passed by the regex. (A
    // "< 200 ms" at 50,000 was one scheduler stall from red — develop CI,
    // 2026-10-09.)
    it('strips 200,000 unclosed openers in linear time', () => {
        const value = `${'<'.repeat(200_000)}ok`;

        const started = performance.now();
        const stripped = stripHtmlTags(value);
        const elapsedMs = performance.now() - started;

        expect(stripped).toBe(value);
        expect(elapsedMs).toBeLessThan(2_000);
    });
});
