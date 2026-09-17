/**
 * Convert free text to a URL-safe slug.
 *
 * **Behavioural details worth knowing:**
 *
 *   - **NFKD normalisation** decomposes accented characters (`é`
 *     → `e` + combining accent), then the `[^\w-]+` strip removes
 *     the combining marks. Net: `"Café Latté"` → `"cafe-latte"`.
 *   - **CJK / Arabic / emoji disappear entirely.** `\w` is ASCII
 *     `[A-Za-z0-9_]` only, so `"日本語"` slugifies to `""`. Callers
 *     that need to support non-Latin scripts must add a Unicode
 *     transliteration pass upstream (e.g. `unidecode`) before
 *     calling this.
 *   - **`_` is preserved** — `\w` includes underscore. `"foo_bar"`
 *     stays `"foo_bar"`. URLs accept it, but if you want a strict
 *     hyphen-only slug, the caller has to post-process.
 *   - **Empty result possible** — input made entirely of stripped
 *     chars returns `""`. Callers that need a guaranteed non-empty
 *     slug must check + fall through (e.g. to a UUID).
 */
export function slugifyText(text: string): string {
    return text
        .toString()
        .normalize('NFKD') // Normalize accented characters
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w-]+/g, '')
        .replace(/--+/g, '-');
}

/**
 * Convert a slug back to a human-readable title-cased string.
 *
 * **NOT a true inverse of {@link slugifyText}.** Information lost
 * during slugification (case, accents, removed chars) cannot be
 * recovered — `unSlugifyText(slugifyText("Café Latté"))` returns
 * `"Cafe Latte"`, not the original. Use only for display when no
 * canonical source is available.
 */
export function unSlugifyText(slug: string): string {
    return slug
        .replace(/-/g, ' ')
        .replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase());
}

/**
 * Strip the given characters from both ends of `value`, in linear time.
 *
 * **Why this is not a regex.** The obvious spelling of an edge trim —
 * `value.replace(/^-+|-+$/g, '')` — is polynomial on paper: a trailing-anchored
 * `-+$` can be retried from every offset inside a long run. CodeQL flags it for
 * that reason.
 *
 * Measured, that cost does not currently appear: V8 optimises the anchored trim
 * and handles a 160k-character run of `-` in well under a millisecond, flat as
 * the input grows. So this is not a fix for a live denial of service, and it
 * should not be described as one. It is here because the guarantee should come
 * from the code rather than from an engine optimisation the caller cannot see,
 * and because it silences a standing alert on a hot path that takes user
 * filenames and document titles. A two-pointer scan cannot backtrack at all.
 *
 * `leading` and `trailing` are sets of characters, not patterns; each is
 * matched literally. Trimming meets in the middle, so an all-trimmable string
 * returns `''`.
 */
export function trimEdgeChars(value: string, leading: string, trailing: string): string {
    let start = 0;
    let end = value.length;
    while (start < end && leading.includes(value[start])) start++;
    while (end > start && trailing.includes(value[end - 1])) end--;
    return value.slice(start, end);
}
