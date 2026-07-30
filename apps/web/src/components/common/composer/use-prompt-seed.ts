'use client';

import { useCallback, useRef } from 'react';

/**
 * Seeding the composer from a chip pick.
 *
 * Picking "Directory" used to change only the placeholder — the box stayed
 * empty and the user still had to invent the first sentence. Instead the chip
 * now writes its example straight into the input, so the pick produces a real
 * prompt the user can edit or send as-is.
 *
 * The one rule: never destroy words the user actually wrote. A seed lands in
 * an empty box, or replaces a seed we put there ourselves when the user picks
 * a different chip. The moment the text is theirs, chips go back to only
 * switching the kind.
 */

/**
 * Turns a typewriter placeholder example (`e.g. "Directory of …"`) into
 * submittable prompt text. The placeholder lists are already each surface's
 * source of truth for "what a good prompt for this kind looks like", so
 * seeding from them keeps the example and the seed from drifting apart.
 */
export function seedFromExample(example: string): string {
    return example
        .replace(/^\s*e\.g\.\s*/i, '')
        .replace(/^"|"$/g, '')
        .trim();
}

export interface PromptSeedOptions {
    /** Current composer value (the surface owns the state). */
    readonly value: string;
    readonly onChange: (next: string) => void;
    /**
     * `inputId` of the composer's textarea. When set, focus returns to the
     * input with the caret at the end so the user can keep typing where the
     * seeded sentence left off.
     */
    readonly inputId?: string;
}

/**
 * Returns `seed(text)`. Call it from a chip's click handler; it no-ops when
 * the box holds the user's own writing.
 */
export function usePromptSeed({ value, onChange, inputId }: PromptSeedOptions) {
    // The exact string we last seeded. Anything else in the box came from the
    // user (typed, pasted, or dictated) and is off limits.
    const seededRef = useRef<string | null>(null);

    return useCallback(
        (seed: string) => {
            const userWrote = value.trim().length > 0 && value !== seededRef.current;
            if (userWrote) return;

            seededRef.current = seed;
            onChange(seed);

            if (!inputId || typeof document === 'undefined') return;
            // After the value has actually rendered — `setSelectionRange` on
            // the pre-update value would put the caret in the wrong place.
            requestAnimationFrame(() => {
                const el = document.getElementById(inputId);
                if (!(el instanceof HTMLTextAreaElement)) return;
                el.focus();
                el.setSelectionRange(el.value.length, el.value.length);
            });
        },
        [value, onChange, inputId],
    );
}
