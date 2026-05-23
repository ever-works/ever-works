import { KB_DOCUMENT_CLASSES, type KbDocumentClass } from '@ever-works/contracts';

/**
 * EW-641 Phase 2/c row 35a — pure `kb:{class}/{slug}` citation parser.
 *
 * Companion to row 34a's `parseKbMentions` (which scans `@kb:` user-
 * input mentions). This parser scans assistant-side message text for
 * the bare `kb:{class}/{slug}` citation tokens that row 34d's prompt
 * instructs the LLM to emit when referencing KB documents. The row
 * 35c `<CitationHover>` UI consumes the extracted offsets to wrap
 * each token with a popover; the row 35b resolver materializes each
 * `(class, slug)` pair to a `KbDocumentBodyDto` for the popover
 * content.
 *
 * Format invariants (locked here, depended on by every downstream
 * citation surface):
 *  - Citation token is always `kb:{class}/{slug}` with no `@` prefix
 *    (`@kb:` is the row 34a user-input mention format — distinct).
 *  - `{class}` MUST be one of the canonical
 *    `KB_DOCUMENT_CLASSES` from `@ever-works/contracts` — citations
 *    with unknown classes are rejected (the LLM hallucinated; row
 *    35c will skip them rather than make a bogus hover-card).
 *  - `{slug}` matches `[A-Za-z0-9_.\-]+` — slugs/paths in the agent
 *    package use these chars exclusively.
 *  - Whole-token boundary at start: must NOT be preceded by `@`
 *    (that would be a row 34a mention, not a citation) AND must
 *    NOT be preceded by a word char (so URL fragments like
 *    `acme/kb:foo` don't accidentally match).
 *  - Trailing punctuation (`.`, `-`, `_`, `/`) is stripped from the
 *    slug — sentence-final periods don't get absorbed. Mid-slug
 *    dots survive (e.g. `kb:research/v2.1`).
 *
 * **Pure function.** No I/O, no module state. Safe in any context
 * (API service, eval harness, web SSR, test). Returns `[]` for
 * non-string input.
 */

/**
 * A single `kb:{class}/{slug}` citation token extracted from a
 * piece of assistant-message text.
 *
 * - `raw` — the full matched text (`kb:{class}/{slug}`). After
 *   trailing-punctuation trim, the raw is exactly the post-trim
 *   shape so `text.slice(startOffset, endOffset) === raw`.
 * - `cls` — the validated `KbDocumentClass` (row 35b uses this as
 *   the `class` field on the synthesized `KbMention` for resolution).
 * - `slug` — the trimmed slug (post-punctuation-trim).
 * - `startOffset` / `endOffset` — 0-based UTF-16 indices identifying
 *   the textual span (so row 35d's renderer can `splice` in the
 *   `<CitationHover>` component).
 */
export interface KbCitation {
    readonly raw: string;
    readonly cls: KbDocumentClass;
    readonly slug: string;
    readonly startOffset: number;
    readonly endOffset: number;
}

/**
 * Regex notes:
 *  - `(?<![@A-Za-z0-9_])` — lookbehind: NOT preceded by `@` (row 34a
 *    mention takes precedence) AND NOT preceded by a word char
 *    (start-of-string / whitespace / punctuation is fine).
 *  - `kb:` — literal prefix (no `@`).
 *  - `([A-Za-z0-9_-]+)` — class capture. We validate against the
 *    `KB_DOCUMENT_CLASSES` whitelist post-match; the regex is
 *    permissive on character class because the whitelist check is
 *    cheaper + the regex would be a 100-char alternation otherwise.
 *  - `/` — separator.
 *  - `([A-Za-z0-9/_.\-]+)` — slug capture (same alphabet as row 34a
 *    references; `/` allowed inside the slug for nested paths like
 *    `research/v2.1`).
 *  - `g` flag — `matchAll` walks the whole string in textual order.
 *
 * Node 22 + modern V8 support lookbehinds and `String.prototype.matchAll`.
 */
const KB_CITATION_RE = /(?<![@A-Za-z0-9_])kb:([A-Za-z0-9_-]+)\/([A-Za-z0-9/_.\-]+)/g;

/** Strip trailing punctuation from the slug (same set as row 34a). */
function trimTrailingPunctuation(slug: string): string {
    let end = slug.length;
    while (end > 0) {
        const ch = slug[end - 1];
        if (ch === '.' || ch === '-' || ch === '_' || ch === '/') {
            end--;
        } else {
            break;
        }
    }
    return slug.slice(0, end);
}

const KNOWN_CLASSES: ReadonlySet<string> = new Set(KB_DOCUMENT_CLASSES);

/**
 * Extract every `kb:{class}/{slug}` citation from a piece of text.
 *
 * Citations with unknown classes are rejected (silently skipped) —
 * a hallucinated `kb:unknown/whatever` from a confused LLM should
 * not surface in the hover-card UI.
 *
 * Returns `[]` for empty / whitespace / non-string input. Offsets
 * are UTF-16-unit based (matches `String.prototype.slice`). The
 * parser is byte-/codepoint-agnostic since the grammar is ASCII-only.
 */
export function parseKbCitations(text: string): KbCitation[] {
    if (typeof text !== 'string' || text.length === 0) return [];

    const out: KbCitation[] = [];
    for (const m of text.matchAll(KB_CITATION_RE)) {
        // `matchAll` with a global regex yields `m.index` reliably,
        // but the type sig says `number | undefined` — be defensive.
        if (m.index === undefined) continue;

        const rawClass = m[1];
        const rawSlug = m[2];

        // Reject unknown classes — the LLM hallucinated or the user
        // typed a fake citation. Row 35c never gets a chance to make
        // a bogus hover-card; row 35b never wastes a DB hit.
        if (!KNOWN_CLASSES.has(rawClass)) continue;

        const trimmedSlug = trimTrailingPunctuation(rawSlug);
        if (trimmedSlug.length === 0) continue;

        // Adjust offsets so the trimmed slug is what we report. The
        // matched `m[0]` is `kb:{class}/{rawSlug}` (length = 3 +
        // rawClass.length + 1 + rawSlug.length). Trimming drops only
        // from the end of `rawSlug`, so the raw output is the same
        // string with the trimmed suffix removed.
        const droppedChars = rawSlug.length - trimmedSlug.length;
        const fullLength = m[0].length - droppedChars;
        const raw = m[0].slice(0, fullLength);

        out.push({
            raw,
            cls: rawClass as KbDocumentClass,
            slug: trimmedSlug,
            startOffset: m.index,
            endOffset: m.index + fullLength,
        });
    }
    return out;
}
