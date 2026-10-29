/**
 * Plain text out of a manifest / catalogue / mail string: every `<…>` tag removed,
 * repeatedly, until none is left, then any `<` that could still open one.
 *
 * One `replace(/<[^<>]*>/g, '')` pass is not enough: removing `<b>` from `<scr<b>ipt>`
 * leaves `<script>`. Repeating it until the text stops changing is the complete form
 * (CodeQL js/incomplete-multi-character-sanitization). A tag's body stops at the next
 * `<`, so every pass is linear (js/polynomial-redos), and the passes are capped: real
 * values settle in one or two, and whatever a capped run leaves cannot open a tag once
 * the stray openers (a `<` before a letter, `/`, `!` or `?`) go. `a -> b` and `x < y`
 * keep their text.
 */
export const MAX_TAG_STRIP_PASSES = 32;

export function stripHtmlTags(value: string): string {
    let current = value;
    let previous: string;
    let passes = 0;
    do {
        previous = current;
        current = current.replace(/<[^<>]*>/g, '');
    } while (current !== previous && ++passes < MAX_TAG_STRIP_PASSES);
    return current.replace(/<(?=[a-z/!?])/gi, '');
}
