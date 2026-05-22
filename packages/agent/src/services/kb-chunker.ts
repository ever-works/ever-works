/**
 * Hybrid chunker for KB document bodies.
 *
 * EW-641 Phase 2/a row 28. Produces `KbChunk[]` from a markdown body
 * using a heading-aware split (H2/H3) with a 512-token fixed-size
 * fallback (sliding window with 64-token overlap) for any section that
 * exceeds the cap. The resulting array is consumed by row 29's
 * embedding Trigger.dev task and persisted as `WorkKnowledgeChunk` rows
 * keyed by `(workId, id)` (see `work-knowledge-chunk.entity.ts`).
 *
 * **Tokenizer choice.** We approximate token count as
 * `Math.ceil(text.length / 4)` — OpenAI's published heuristic for
 * English text. `js-tiktoken` is in the workspace as a transitive
 * LangChain dep, but pulling it in here costs ~6 MiB of ranks JSON
 * loaded on first call, which is wasteful for a function that runs
 * inside a Trigger.dev task on every doc save. If retrieval quality
 * regressions trace back to chunk-size drift we can swap in `js-tiktoken`
 * locally without changing the call sites — the `estimateTokens` seam
 * is the only thing that needs to flip.
 *
 * **Heading semantics.** H1 is intentionally NOT a split point: spec
 * docs typically have one H1 (the title) and chunking on it would
 * produce a single oversized chunk that immediately falls into the
 * sliding-window path, throwing away the structural information. H2
 * opens a new top-level section; H3 nests under the most recent H2 and
 * REPLACES any previous H3 in `headingPath`. Lines inside fenced code
 * blocks (``` … ``` or ~~~ … ~~~) never count as headings — common
 * markdown pitfall (a code sample showing `## heading` would otherwise
 * spuriously split the section).
 *
 * **Sliding window.** When a section is over the cap, slide a window
 * of `maxTokens * CHARS_PER_TOKEN` chars forward with
 * `overlap * CHARS_PER_TOKEN` overlap. Each sub-chunk inherits its
 * parent section's `headingPath` so retrieval can still cite the
 * section that produced it. The character offsets in `charStart` /
 * `charEnd` are relative to the ORIGINAL body, not the section — that
 * way row 30's citation-rendering can compute exact spans without
 * tracking offsets through the sectioning.
 *
 * **Pure function.** No I/O, no module-scoped state. Safe to call from
 * any context (Trigger.dev task, unit test, dev preview).
 */

export interface KbChunk {
    /** 0-based ordinal within the produced array. */
    index: number;
    /**
     * The chunk text. INCLUDES the heading line(s) that opened the
     * section so embeddings see "Brand voice / Examples" context not
     * just the body bullets.
     */
    content: string;
    /**
     * The stack of H2/H3 headings the chunk lives under, outer-most
     * first. Empty for the leading section before any H2/H3 heading.
     * Example: `['Brand voice', 'Examples']` for an H3 nested under an
     * H2.
     */
    headingPath?: string[];
    /** Inclusive char offset into the original body where the chunk starts. */
    charStart: number;
    /** Exclusive char offset where the chunk ends. */
    charEnd: number;
}

export interface ChunkMarkdownOptions {
    /** Soft cap in tokens before the sliding-window fallback fires. Default 512. */
    maxTokens?: number;
    /** Window overlap in tokens. Default 64. */
    overlap?: number;
}

const DEFAULT_MAX_TOKENS = 512;
const DEFAULT_OVERLAP = 64;
/**
 * OpenAI's published heuristic for English text. Far from perfect for
 * code/JSON/multilingual bodies but it's deterministic and pure — see
 * the module docstring for the tradeoff vs `js-tiktoken`.
 */
const CHARS_PER_TOKEN = 4;

/** Internal record of a heading-defined section before chunking. */
interface Section {
    /** Heading path active at the START of this section. */
    headingPath: string[];
    /** Section text, including any leading heading line(s). */
    content: string;
    charStart: number;
    charEnd: number;
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Walk the body line-by-line splitting at H2/H3 heading boundaries,
 * tracking a heading stack and skipping code fences. Returns at least
 * one section even for body-only input (with `headingPath: []`).
 */
function splitIntoSections(body: string): Section[] {
    if (body.length === 0) return [];

    const sections: Section[] = [];
    let h2: string | null = null;
    let h3: string | null = null;

    /** Char offset where the CURRENT (in-progress) section starts. */
    let sectionStart = 0;
    let sectionHeadingPath: string[] = [];

    let cursor = 0;
    let inFence = false;
    let fenceMarker: string | null = null;

    const pushSection = (endOffset: number, nextHeadingPath: string[]) => {
        if (endOffset > sectionStart) {
            sections.push({
                headingPath: [...sectionHeadingPath],
                content: body.slice(sectionStart, endOffset),
                charStart: sectionStart,
                charEnd: endOffset,
            });
        }
        sectionStart = endOffset;
        sectionHeadingPath = nextHeadingPath;
    };

    while (cursor < body.length) {
        // Find end of this line (exclusive of the newline). Track the
        // newline length so the next iteration starts past it.
        const newlineIdx = body.indexOf('\n', cursor);
        const lineEndExclusive = newlineIdx === -1 ? body.length : newlineIdx;
        const line = body.slice(cursor, lineEndExclusive);

        // Code fence toggling — track the marker so a ``` block isn't
        // closed by a ~~~ and vice versa.
        const fenceMatch = /^(```+|~~~+)/.exec(line);
        if (fenceMatch) {
            const marker = fenceMatch[1][0]; // '`' or '~'
            if (!inFence) {
                inFence = true;
                fenceMarker = marker;
            } else if (fenceMarker === marker) {
                inFence = false;
                fenceMarker = null;
            }
        }

        if (!inFence) {
            const h2Match = /^##\s+(.+?)\s*$/.exec(line);
            const h3Match = /^###\s+(.+?)\s*$/.exec(line);
            if (h2Match) {
                h2 = h2Match[1];
                h3 = null;
                pushSection(cursor, [h2]);
            } else if (h3Match) {
                h3 = h3Match[1];
                pushSection(cursor, h2 ? [h2, h3] : [h3]);
            }
        }

        cursor = newlineIdx === -1 ? body.length : newlineIdx + 1;
    }

    // Flush the trailing section.
    pushSection(body.length, []);

    return sections;
}

/**
 * Sub-divide a single oversized section with a sliding window. The
 * window slides forward by `(maxTokens - overlap) * CHARS_PER_TOKEN`
 * chars each step; the last window snaps to the section end so we don't
 * lose tail bytes. The returned chunks' `headingPath` is inherited from
 * the caller; offsets are relative to the original body.
 */
function slidingWindow(
    section: Section,
    maxTokens: number,
    overlap: number,
): Array<{ content: string; charStart: number; charEnd: number }> {
    const windowChars = maxTokens * CHARS_PER_TOKEN;
    const stepChars = Math.max(1, (maxTokens - overlap) * CHARS_PER_TOKEN);

    const out: Array<{ content: string; charStart: number; charEnd: number }> = [];
    let start = section.charStart;
    const sectionEnd = section.charEnd;

    while (start < sectionEnd) {
        const end = Math.min(start + windowChars, sectionEnd);
        out.push({
            content: section.content.slice(start - section.charStart, end - section.charStart),
            charStart: start,
            charEnd: end,
        });
        if (end >= sectionEnd) break;
        start += stepChars;
    }

    return out;
}

/**
 * Chunk a markdown document body for embedding. Returns an empty array
 * for empty / whitespace-only bodies.
 */
export function chunkMarkdown(body: string, opts: ChunkMarkdownOptions = {}): KbChunk[] {
    const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const overlap = opts.overlap ?? DEFAULT_OVERLAP;

    if (maxTokens <= 0) {
        throw new RangeError(`chunkMarkdown: maxTokens must be > 0 (got ${maxTokens})`);
    }
    if (overlap < 0 || overlap >= maxTokens) {
        throw new RangeError(
            `chunkMarkdown: overlap must be in [0, maxTokens) (got overlap=${overlap}, maxTokens=${maxTokens})`,
        );
    }

    if (!body || body.trim() === '') return [];

    const sections = splitIntoSections(body);
    const chunks: KbChunk[] = [];
    let index = 0;

    for (const section of sections) {
        // Strip pure-whitespace sections (e.g. blank line between two
        // back-to-back H2s) without inflating chunk count.
        if (section.content.trim() === '') continue;

        if (estimateTokens(section.content) <= maxTokens) {
            chunks.push({
                index: index++,
                content: section.content,
                headingPath: section.headingPath.length > 0 ? [...section.headingPath] : undefined,
                charStart: section.charStart,
                charEnd: section.charEnd,
            });
            continue;
        }

        for (const sub of slidingWindow(section, maxTokens, overlap)) {
            chunks.push({
                index: index++,
                content: sub.content,
                headingPath: section.headingPath.length > 0 ? [...section.headingPath] : undefined,
                charStart: sub.charStart,
                charEnd: sub.charEnd,
            });
        }
    }

    return chunks;
}
