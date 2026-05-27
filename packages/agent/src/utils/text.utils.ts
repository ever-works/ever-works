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
