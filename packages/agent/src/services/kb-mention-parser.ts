/**
 * EW-641 Phase 2/c row 34a — pure `@kb:` mention parser.
 *
 * The AI conversation surface (spec §15.5, rows 34/35) lets users
 * point the model at specific KB documents inline by typing
 * `@kb:<reference>` in their message. This module extracts those
 * mentions from plain text so:
 *  - row 34b can resolve each reference to a `KbDocumentBodyDto`
 *    via `KnowledgeBaseService.findByWorkOrPath`,
 *  - row 34c can inject the resolved docs as a `<kb>...</kb>`
 *    context block (via row 31 `formatKbContext`) in the system
 *    message before the LLM call,
 *  - the row 35 hover-card UI can underline the same offsets in
 *    the rendered message.
 *
 * Pure function — no I/O, no module state, no DOM. Safe to call
 * from any context (API service, Trigger.dev task, eval harness,
 * test). The format mirrors the row 31 citation `kb:{class}/{slug}`
 * so a user can paste a citation back at the model and it round-
 * trips cleanly.
 *
 * Reference grammar (`[A-Za-z0-9/_.\-]+`):
 *  - alnum + `/` (path separator) + `_` + `.` + `-` — covers slugs,
 *    nested paths (`brand/voice`), kebab-case slugs, and IDs.
 *  - must follow `@kb:` immediately (no whitespace between `:` and
 *    the first reference char).
 *  - terminates at the first character outside the class — i.e.
 *    whitespace, punctuation `,;:!?'"`, parens / brackets / braces,
 *    or end-of-string.
 *
 * **Whole-word boundary at start.** `@kb:` only counts when not
 * preceded by a "word" character (`[A-Za-z0-9_]`) — keeps us from
 * matching inside words like `foo@kb:bar` (we want just the bare
 * mention). Markdown-link awareness (`[@kb:x](url)`) is deferred
 * to row 34c if anchor confusion shows up in practice; for now we
 * extract every textual `@kb:` and let the resolver swallow misses
 * gracefully.
 */

/**
 * A single `@kb:` mention extracted from a piece of text.
 *
 * - `raw` — the full match including the `@kb:` prefix (so callers
 *   can substitute it for a UI marker without re-deriving from
 *   offsets).
 * - `reference` — the bare reference (what was after `@kb:`).
 * - `startOffset` — 0-based UTF-16 index of the leading `@`.
 * - `endOffset` — 0-based UTF-16 index one past the last reference
 *   char (so `text.slice(startOffset, endOffset) === raw`).
 */
export interface KbMention {
    readonly raw: string;
    readonly reference: string;
    readonly startOffset: number;
    readonly endOffset: number;
}

/**
 * Regex notes:
 *  - `(?<![A-Za-z0-9_])` — lookbehind: NOT preceded by a word char
 *    (so `foo@kb:bar` doesn't match, but `(@kb:bar` and ` @kb:bar`
 *    and start-of-string do).
 *  - `@kb:` — literal prefix.
 *  - `([A-Za-z0-9/_.\-]+)` — reference, captured. `.` is allowed
 *    inside the reference (for version-style slugs like `v2.1`),
 *    then post-match we strip trailing `.` so a sentence-final
 *    period doesn't get absorbed.
 *  - global + non-sticky so `matchAll` walks the whole string.
 *
 * Node 22 + modern V8 support lookbehinds and `String.prototype.matchAll`.
 */
const KB_MENTION_RE = /(?<![A-Za-z0-9_])@kb:([A-Za-z0-9/_.\-]+)/g;

/**
 * Strip trailing punctuation-ish characters from the captured
 * reference. `.` is most common (sentence-final period) but `-`,
 * `_`, and `/` can also dangle if the user trails into a thought
 * — none of those are meaningful at the end of a real KB slug or
 * path. We trim them in a loop so e.g. `@kb:legal...` collapses
 * cleanly back to `legal`.
 */
function trimTrailingPunctuation(ref: string): string {
    let end = ref.length;
    while (end > 0) {
        const ch = ref[end - 1];
        if (ch === '.' || ch === '-' || ch === '_' || ch === '/') {
            end--;
        } else {
            break;
        }
    }
    return ref.slice(0, end);
}

/**
 * Extract every `@kb:<reference>` mention from a message.
 *
 * - Returns `[]` for empty/whitespace input.
 * - Mentions are returned in textual order (left-to-right).
 * - Adjacent or repeated references are each reported separately;
 *   row 34b is responsible for deduplication before resolution.
 * - Offsets are UTF-16-unit based (matches `String.prototype.slice`
 *   and `String.prototype.length`); the parser is byte-/codepoint-
 *   agnostic since the reference grammar is ASCII-only.
 */
export function parseKbMentions(text: string): KbMention[] {
    if (typeof text !== 'string' || text.length === 0) return [];

    const out: KbMention[] = [];
    for (const m of text.matchAll(KB_MENTION_RE)) {
        // `matchAll` with a global regex always yields `m.index`
        // (number) — but the type sig says `number | undefined`, so
        // defensively skip if missing.
        if (m.index === undefined) continue;
        const fullMatch = m[0];
        const rawReference = m[1];
        const trimmedReference = trimTrailingPunctuation(rawReference);
        // If everything got stripped (e.g. `@kb:....`), drop the
        // mention entirely — no useful reference.
        if (trimmedReference.length === 0) continue;

        // Adjust offsets so the trimmed reference is what we report.
        // `raw` includes the `@kb:` prefix (4 chars) + trimmedReference.
        const droppedChars = rawReference.length - trimmedReference.length;
        const raw = fullMatch.slice(0, fullMatch.length - droppedChars);
        out.push({
            raw,
            reference: trimmedReference,
            startOffset: m.index,
            endOffset: m.index + raw.length,
        });
    }
    return out;
}
