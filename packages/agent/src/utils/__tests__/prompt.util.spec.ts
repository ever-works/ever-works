import { appendCustomPrompt } from '../prompt.util';

describe('appendCustomPrompt', () => {
    const base = 'You are a helpful assistant.';

    it('returns base prompt verbatim when customPrompt is undefined', () => {
        expect(appendCustomPrompt(base, undefined)).toBe(base);
    });

    it('returns base prompt verbatim when customPrompt is null', () => {
        expect(appendCustomPrompt(base, null)).toBe(base);
    });

    it('returns base prompt verbatim when customPrompt is empty string', () => {
        expect(appendCustomPrompt(base, '')).toBe(base);
    });

    it('returns base prompt verbatim when customPrompt is whitespace-only', () => {
        // The .trim().length === 0 guard catches whitespace-only inputs so they
        // do not produce a stray "Additional User Instructions" header with empty body.
        expect(appendCustomPrompt(base, '   ')).toBe(base);
        expect(appendCustomPrompt(base, '\n\t  \n')).toBe(base);
    });

    it('appends custom prompt under "## Additional User Instructions:" header', () => {
        const result = appendCustomPrompt(base, 'Be concise');
        expect(result).toBe(`${base}\n\n## Additional User Instructions:\nBe concise`);
    });

    it('trims the custom prompt before appending (leading/trailing whitespace stripped)', () => {
        const result = appendCustomPrompt(base, '   Be concise   ');
        expect(result).toBe(`${base}\n\n## Additional User Instructions:\nBe concise`);
    });

    it('preserves internal whitespace in the custom prompt verbatim', () => {
        const result = appendCustomPrompt(base, 'Line one\nLine two\n  indented');
        expect(result).toBe(`${base}\n\n## Additional User Instructions:\nLine one\nLine two\n  indented`);
    });

    it('separates the custom prompt from the base with exactly one blank line', () => {
        // The exact blank-line separator is part of the contract — it makes the
        // resulting prompt parse cleanly as Markdown. Pin the literal "\n\n" so a
        // future "merge to single newline" refactor breaks loudly.
        const result = appendCustomPrompt('A', 'B');
        expect(result).toBe('A\n\n## Additional User Instructions:\nB');
        expect(result.split('\n\n')).toHaveLength(2);
    });

    it('handles empty base prompt by still emitting the header before custom text', () => {
        const result = appendCustomPrompt('', 'do this');
        expect(result).toBe('\n\n## Additional User Instructions:\ndo this');
    });

    it('does not double-trim when custom prompt has only internal whitespace runs', () => {
        // Verifies the behaviour: single trim() pass, no .replace() collapse.
        const result = appendCustomPrompt(base, 'a    b');
        expect(result).toBe(`${base}\n\n## Additional User Instructions:\na    b`);
    });
});
