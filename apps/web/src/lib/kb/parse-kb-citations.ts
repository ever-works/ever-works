import { KB_DOCUMENT_CLASSES, type KbDocumentClass } from '@ever-works/contracts';

/**
 * EW-641 Phase 2/c row 35d — web-side port of the agent's
 * `parseKbCitations` (row 35a, PR #983).
 *
 * The agent package can't be imported from `apps/web` (web only
 * depends on `@ever-works/contracts` + `@ever-works/plugin`, and
 * `@ever-works/agent` pulls in NestJS / TypeORM / BullMQ which
 * have no business in a browser bundle). This file mirrors the
 * agent's parser so the row 35d conversation renderer can scan
 * assistant-text on the client side without a network round-trip.
 *
 * Keep this file in lockstep with
 * `packages/agent/src/services/kb-citation-parser.ts` — the regex,
 * trim policy, and whitelist must match exactly so the same citation
 * tokens are recognised on both sides of the API boundary (server-
 * side resolver inputs from row 35b, client-side hover-card targets
 * from row 35c).
 *
 * **Pure function.** No I/O, no module state. Returns `[]` for
 * non-string input.
 */

export interface KbCitation {
    readonly raw: string;
    readonly cls: KbDocumentClass;
    readonly slug: string;
    readonly startOffset: number;
    readonly endOffset: number;
}

/**
 * Same regex as the agent-side parser:
 *  - `(?<![@A-Za-z0-9_])` lookbehind blocks leading `@` (that's the
 *    row 34a user-input mention syntax) and word-char prefixes.
 *  - `kb:` literal prefix.
 *  - `([A-Za-z0-9_-]+)` class capture, validated against the
 *    `KB_DOCUMENT_CLASSES` whitelist post-match.
 *  - `/` separator.
 *  - `([A-Za-z0-9/_.\-]+)` slug capture (nested `/` paths + dotted
 *    version slugs both supported).
 */
const KB_CITATION_RE = /(?<![@A-Za-z0-9_])kb:([A-Za-z0-9_-]+)\/([A-Za-z0-9/_.\-]+)/g;

const KNOWN_CLASSES: ReadonlySet<string> = new Set(KB_DOCUMENT_CLASSES);

/**
 * Strip trailing punctuation (`.`, `-`, `_`, `/`) from the slug —
 * sentence-final periods don't get absorbed. Mid-slug dots survive
 * (`research/v2.1`).
 */
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

/**
 * Extract every `kb:{class}/{slug}` citation from a piece of text.
 *
 * Citations with unknown classes (not in `KB_DOCUMENT_CLASSES`) are
 * silently rejected — a hallucinated `kb:unknown/whatever` from a
 * confused LLM should not surface in the hover-card UI. Returns
 * matches in textual order.
 */
export function parseKbCitations(text: string): KbCitation[] {
    if (typeof text !== 'string' || text.length === 0) return [];

    const out: KbCitation[] = [];
    for (const m of text.matchAll(KB_CITATION_RE)) {
        if (m.index === undefined) continue;

        const rawClass = m[1];
        const rawSlug = m[2];

        if (!KNOWN_CLASSES.has(rawClass)) continue;

        const trimmedSlug = trimTrailingPunctuation(rawSlug);
        if (trimmedSlug.length === 0) continue;

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
