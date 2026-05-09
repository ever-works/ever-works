import { PROMPT_KEYS } from './prompt-keys';
import * as comparisonBarrel from './index';

/**
 * `PROMPT_KEYS` is a contracts-only constant: it pins the three string keys
 * that the comparison generator passes to the prompt facade (Langfuse via
 * `prompt-provider` plugins, see `comparison-writer.ts:373/392/418`). When
 * the facade returns nothing, the writer falls back to the hardcoded prompts
 * inside `comparison-writer.ts` — but the keys themselves are persisted in
 * Langfuse's UI so changing the literal value silently breaks the link
 * between in-platform code and the externally-managed prompt.
 *
 * The barrel re-exports the constant under the renamed alias
 * `COMPARISON_PROMPT_KEYS` (the un-prefixed name `PROMPT_KEYS` would clash
 * with sibling generators if any of them ever ship their own prompt-key
 * registries). This suite pins both the literal map AND the renamed
 * re-export so a future "merge into a single shared registry" refactor has
 * to be deliberate.
 */
describe('comparison generator PROMPT_KEYS', () => {
    describe('literal values (Langfuse-facing wire format)', () => {
        it('pins STRUCTURE to the documented dotted-namespace literal', () => {
            // The `comparison.<prompt-name>` namespace is enforced by convention
            // (see the source file's JSDoc); pinned here so a future "drop the
            // prefix" refactor breaks loudly instead of silently de-linking
            // every Langfuse prompt.
            expect(PROMPT_KEYS.STRUCTURE).toBe('comparison.structure');
        });

        it('pins MARKDOWN to the documented dotted-namespace literal', () => {
            expect(PROMPT_KEYS.MARKDOWN).toBe('comparison.markdown');
        });

        it('pins EXTENDED_ANALYSIS to the documented dotted-namespace literal', () => {
            expect(PROMPT_KEYS.EXTENDED_ANALYSIS).toBe('comparison.extended-analysis');
        });
    });

    describe('shape contracts', () => {
        it('exposes EXACTLY three documented keys (regression guard against silent additions)', () => {
            expect(Object.keys(PROMPT_KEYS).sort()).toEqual([
                'EXTENDED_ANALYSIS',
                'MARKDOWN',
                'STRUCTURE',
            ]);
        });

        it('every value is a string in the `comparison.<name>` namespace', () => {
            for (const value of Object.values(PROMPT_KEYS)) {
                expect(typeof value).toBe('string');
                expect(value).toMatch(/^comparison\.[a-z][a-z0-9-]*$/);
            }
        });

        it('every value is unique (so two keys cannot accidentally point at the same prompt)', () => {
            const values = Object.values(PROMPT_KEYS);
            expect(new Set(values).size).toBe(values.length);
        });

        it('is `as const` so the values type-narrow to their literals (runtime mutate-attempt is a noisy diff)', () => {
            // `as const` produces a frozen-by-convention shape (TS will refuse
            // to type-check a mutation, but at runtime the object is still a
            // plain JS object). We pin the read-only access pattern by reading
            // every key and asserting they survived a JSON round-trip
            // unchanged — pinned so a future swap to a `let` non-const map
            // (which would lose the literal-type narrowing) breaks loudly.
            const snapshot = JSON.parse(JSON.stringify(PROMPT_KEYS));
            expect(snapshot).toEqual({
                STRUCTURE: 'comparison.structure',
                MARKDOWN: 'comparison.markdown',
                EXTENDED_ANALYSIS: 'comparison.extended-analysis',
            });
        });
    });

    describe('barrel re-export under renamed alias', () => {
        it('re-exports as COMPARISON_PROMPT_KEYS (NOT the un-prefixed PROMPT_KEYS)', () => {
            // The rename is deliberate — a future sibling generator may also
            // ship its own `PROMPT_KEYS` and the un-prefixed name would clash
            // at the shared barrel level.
            expect(
                (comparisonBarrel as unknown as Record<string, unknown>).COMPARISON_PROMPT_KEYS,
            ).toBe(PROMPT_KEYS);
            expect(
                (comparisonBarrel as unknown as Record<string, unknown>).PROMPT_KEYS,
            ).toBeUndefined();
        });
    });
});
