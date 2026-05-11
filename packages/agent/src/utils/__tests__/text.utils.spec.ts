import { slugifyText, unSlugifyText } from '../text.utils';

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
