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
 * `value.replace(/^-+|-+$/g, '')` — is polynomial: a trailing-anchored `-+$` is
 * retried from every offset inside a run, and each retry scans the rest of it.
 * CodeQL flags it for that reason.
 *
 * Measured on V8 (Node 24), the cost depends on where the run sits. A run that
 * ends the string is matched on the first try — 160k `-` in well under a
 * millisecond. A run that does NOT end the string (`a` + n × `-` + `b`) fails
 * `$` from every offset and is genuinely quadratic: about 0.4 s at n = 20,000
 * and 1.7 s at n = 40,000. So on user input that can carry such a run, the regex
 * is a live denial of service, and this two-pointer scan — which cannot
 * backtrack at all — is the fix, not a cosmetic one. (Input whose runs were
 * already collapsed to one character is safe either way; the scan still makes
 * that guarantee local instead of depending on the line above.)
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

/**
 * Remove every `<…>` span from `value` — each `<` through the first `>` after
 * it — in one linear pass. Same result as `value.replace(/<[^>]*>/g, '')`.
 *
 * **Why this is not that regex.** `<[^>]*>` is retried from every `<` that no
 * `>` follows, and each retry scans to the end: 50,000 `<` take seconds.
 *
 * **What it does not do.** A `<` that no `>` follows is not a span, so it is
 * kept, exactly as the regex kept it. Such an unclosed opener is still the
 * start of a tag once the value is placed in HTML that supplies a `>` —
 * callers whose contract is "no markup" must drop the stray `<` themselves
 * (see `stripTemplateHtml`, `TemplateCatalogService`).
 */
export function stripHtmlTags(value: string): string {
    let stripped = '';
    let cursor = 0;
    for (;;) {
        const open = value.indexOf('<', cursor);
        if (open === -1) break;
        const close = value.indexOf('>', open + 1);
        // No `>` after this `<` means none after any later `<` either.
        if (close === -1) break;
        stripped += value.slice(cursor, open);
        cursor = close + 1;
    }
    return cursor === 0 ? value : stripped + value.slice(cursor);
}
