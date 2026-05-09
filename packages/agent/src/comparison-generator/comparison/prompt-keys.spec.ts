import { PROMPT_KEYS } from './prompt-keys';

describe('comparison-generator prompt-keys', () => {
    it('exposes the three documented keys', () => {
        expect(Object.keys(PROMPT_KEYS).sort()).toEqual(
            ['EXTENDED_ANALYSIS', 'MARKDOWN', 'STRUCTURE'].sort(),
        );
    });

    it('uses the canonical "comparison.<name>" wire format for every key', () => {
        // Pinned because Langfuse + the comparison-writer fallback both
        // depend on these literal strings — silently renaming one would
        // detach external prompts from their consumers.
        expect(PROMPT_KEYS.STRUCTURE).toBe('comparison.structure');
        expect(PROMPT_KEYS.MARKDOWN).toBe('comparison.markdown');
        expect(PROMPT_KEYS.EXTENDED_ANALYSIS).toBe('comparison.extended-analysis');
    });

    it('every value is unique (no two keys point at the same wire string)', () => {
        const values = Object.values(PROMPT_KEYS);
        expect(new Set(values).size).toBe(values.length);
    });

    it('every key follows the "comparison." namespace prefix', () => {
        for (const value of Object.values(PROMPT_KEYS)) {
            expect(value).toMatch(/^comparison\./);
        }
    });

    it('is frozen by `as const` (TypeScript-side narrowing) — runtime values match the assertion', () => {
        // The `as const` assertion is purely type-level; at runtime, the object is
        // still mutable. Pin the current behaviour explicitly so a future
        // `Object.freeze(PROMPT_KEYS)` call is a deliberate change.
        expect(Object.isFrozen(PROMPT_KEYS)).toBe(false);
    });
});
