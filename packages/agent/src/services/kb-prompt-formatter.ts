import type { KbDocumentBodyDto } from '@ever-works/contracts';

/**
 * EW-641 Phase 2/b row 31 — standardized KB context block formatter.
 *
 * Every Phase 2/b pipeline injects a `<kb>...</kb>` block carrying the
 * resolved KB documents (the union of always-injected + query-retrieved
 * docs per spec §15). Centralizing the format here means we can:
 *  - tune the block once and every consumer picks it up (no drift
 *    between pipelines)
 *  - keep token budgets predictable by enforcing a single `maxChars`
 *    cap with deterministic truncation
 *  - swap to a different format (XML attributes vs heading-prefixed
 *    sections, citation footers, etc.) without re-touching every
 *    pipeline call site
 *
 * Wire format (spec §15.6):
 *
 *   <kb>
 *   ## {title} (kb:{class}/{slug})
 *   {body}
 *   ---
 *   ## {title} (kb:{class}/{slug})
 *   {body}
 *   </kb>
 *
 * - Opening/closing `<kb>` tags on their own lines so prompts can use
 *   them as delimiters (LLM is told "the KB is between `<kb>` tags").
 * - `kb:{class}/{slug}` citation reference matches the `@kb:` mention
 *   parser format (row 17). Citations rendered by the conversation UI
 *   (row 34/35) link straight back to the workbench doc page.
 * - Per-doc body verbatim — chunk-aware formatting belongs to row 30's
 *   retrieval blend; this formatter takes whole-doc DTOs and stitches.
 * - Docs joined by `\n---\n` (markdown thematic break). Models pick up
 *   "separate documents" cue without us needing to over-engineer the
 *   delimiter.
 *
 * **Truncation contract.** If the concatenated block exceeds `maxChars`
 * (default 16 000), truncate the LAST document's body — never split
 * a title/citation line. Append `[…truncated]` so the model knows
 * content was clipped (and budget-aware prompt steps can warn the
 * user). Earlier docs are kept whole; an `<kb></kb>` shell will
 * always be returned (callers can rely on the delimiters).
 *
 * **Determinism.** Input order preserved exactly — callers (row 32's
 * `KbContextBundle.format`) decide ordering via spec §15.4's priority
 * (always-injected first, then RRF-ranked query-retrieved).
 *
 * **Pure function.** No I/O, no module state. Safe for any context
 * (pipeline step, eval harness, unit test).
 */

export interface FormatKbContextOptions {
    /**
     * Hard cap on the returned string length, in chars. Defaults to
     * 16 000 — a safe floor for gpt-4o-mini context windows with
     * headroom for the surrounding system prompt + user message. When
     * exceeded, the last doc's body is truncated and `[…truncated]`
     * is appended.
     */
    maxChars?: number;
}

const DEFAULT_MAX_CHARS = 16_000;
const TRUNCATION_MARKER = '\n[…truncated]';
const OPEN_TAG = '<kb>';
const CLOSE_TAG = '</kb>';
const DOC_SEPARATOR = '\n---\n';

/**
 * Build the `<kb>...</kb>` context block from a list of KB documents.
 *
 * Returns `<kb>\n</kb>` for empty input — callers can always treat the
 * tags as present and parse between them. The opening + closing tags
 * are always returned even when over-cap; only body text is trimmed.
 */
export function formatKbContext(
    docs: ReadonlyArray<KbDocumentBodyDto>,
    options: FormatKbContextOptions = {},
): string {
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    if (!Number.isFinite(maxChars) || maxChars < 0) {
        throw new RangeError(
            `formatKbContext: maxChars must be a non-negative finite number (got ${maxChars})`,
        );
    }

    if (docs.length === 0) {
        return `${OPEN_TAG}\n${CLOSE_TAG}`;
    }

    // First-pass: build per-doc full entries. The slug + class come
    // straight from the DTO so the citation reference matches the row
    // 17 `@kb:` mention syntax.
    const entries = docs.map((doc) => {
        const cite = `kb:${doc.class}/${doc.slug}`;
        const heading = `## ${doc.title} (${cite})`;
        const body = doc.body ?? '';
        return { heading, body, full: `${heading}\n${body}` };
    });

    // Concat candidate. Cheap O(n) join — we'll measure and clip if
    // needed in pass 2.
    const joined = entries.map((e) => e.full).join(DOC_SEPARATOR);
    const fullBlock = `${OPEN_TAG}\n${joined}\n${CLOSE_TAG}`;

    if (fullBlock.length <= maxChars) {
        return fullBlock;
    }

    // Over budget — keep all headings, trim from the last doc body
    // backward, then append the truncation marker. We never split a
    // heading line; if even the headings + delimiters don't fit, the
    // entire block degrades to `<kb>\n[…truncated]\n</kb>`.
    const fixedFrame = OPEN_TAG.length + 1 + CLOSE_TAG.length + 1 + TRUNCATION_MARKER.length; // \n on each side
    // Reserve space for every heading + every doc separator and the
    // final newline before the close tag.
    const headingsBudget = entries.map((e) => e.heading.length).reduce((acc, n) => acc + n, 0);
    const separatorsBudget = (entries.length - 1) * DOC_SEPARATOR.length;
    // Per-heading we also need a trailing "\n" before its body.
    const headingNewlinesBudget = entries.length;
    const reservedNonBody = fixedFrame + headingsBudget + separatorsBudget + headingNewlinesBudget;

    if (reservedNonBody >= maxChars) {
        // Even the shells + headings overshoot — return the minimal
        // truncation-only block. Pathological case; logged via the
        // marker but callers shouldn't ever feed this.
        return `${OPEN_TAG}${TRUNCATION_MARKER}\n${CLOSE_TAG}`;
    }

    const totalBodyBudget = maxChars - reservedNonBody;
    // Distribute body budget: keep earlier docs whole, trim from the
    // last. Walk forward summing body lengths until we'd overflow,
    // then clip the offender + truncate everything after.
    const pieces: string[] = [];
    let bodyUsed = 0;
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (i > 0) pieces.push(DOC_SEPARATOR);
        pieces.push(`${e.heading}\n`);
        const remainingBudget = totalBodyBudget - bodyUsed;
        if (remainingBudget <= 0) {
            // No room for this doc's body — its heading is in but the
            // body is implicit "truncated". Stop adding more entries.
            break;
        }
        if (e.body.length <= remainingBudget) {
            pieces.push(e.body);
            bodyUsed += e.body.length;
        } else {
            // Clip this doc and stop.
            pieces.push(e.body.slice(0, remainingBudget));
            bodyUsed = totalBodyBudget;
            break;
        }
    }

    return `${OPEN_TAG}\n${pieces.join('')}${TRUNCATION_MARKER}\n${CLOSE_TAG}`;
}
