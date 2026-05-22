/**
 * Reciprocal Rank Fusion (RRF) helper for KB retrieval.
 *
 * EW-641 Phase 2/a row 30b. Combines multiple ranked lists (lexical
 * + semantic in the typical Phase 2 KB search case) into a single
 * ranking using the standard RRF formula:
 *
 *   score(doc) = Σ_{list ∈ lists}  1 / (k + rank_in_list(doc) + 1)
 *
 * where `rank_in_list` is 0-based and the `+1` makes the top-ranked
 * doc contribute `1/(k+1)` rather than `1/k` (the latter blows up at
 * `k=0`).
 *
 * **Why RRF rather than weighted average?** Lexical and semantic
 * scores live on different scales — TF-IDF returns unbounded
 * positive floats, cosine distance ranges 0..2, and a model swap
 * shifts both distributions. RRF ignores absolute scores and only
 * uses ordinal rank, so a re-ranking from a different embedding
 * model doesn't require re-tuning. The `k` constant (default 60 per
 * the original Cormack et al. 2009 paper, also the LangChain /
 * LlamaIndex default) shapes how aggressively top ranks are
 * rewarded: lower `k` → top of each list dominates; higher `k` →
 * more balanced blend across ranks.
 *
 * **Pure function.** No I/O, no module state, no side effects. Safe
 * to call from any context (service layer, unit test, REPL).
 *
 * **Stability.** When two docs tie on score, ordering is broken by
 * `documentId` ASC. Same input always produces the same output —
 * required so the row-15 search palette doesn't flicker between
 * re-renders against unchanged data.
 *
 * Consumed by row 30c (the rewrite of
 * `KnowledgeBaseService.search` that fuses the lexical filter with
 * `semanticSearch`'s pgvector k-NN).
 */

export interface RrfBlendOptions {
    /**
     * RRF dampening constant. Defaults to 60 (Cormack et al. 2009 /
     * LangChain). Must be a non-negative finite number; `0` is
     * accepted (the `+1` denominator prevents division by zero) but
     * tends to make any list's top doc fully dominate if it's not in
     * the others.
     */
    k?: number;
}

export interface RrfBlendResult {
    documentId: string;
    score: number;
}

/**
 * Blend N ranked lists of `documentId`s using Reciprocal Rank Fusion.
 *
 * Each list is treated as ordered best-first (index 0 = top
 * candidate). Duplicate `documentId`s WITHIN a single list use the
 * FIRST occurrence's rank — callers shouldn't produce duplicates,
 * but the guard prevents a buggy producer from silently inflating a
 * doc's score.
 *
 * Returns docs ranked by total RRF score DESC, tied scores broken by
 * `documentId` ASC for stability.
 *
 * @example
 *   const lexical = [{ documentId: 'a' }, { documentId: 'b' }];
 *   const semantic = [{ documentId: 'b' }, { documentId: 'c' }];
 *   rrfBlend([lexical, semantic]);
 *   // Returns:
 *   //   { documentId: 'b', score: 1/61 + 1/61 }   // top of both
 *   //   { documentId: 'a', score: 1/61 }          // top of lex only
 *   //   { documentId: 'c', score: 1/62 }          // rank-1 of sem only
 */
export function rrfBlend(
    rankings: ReadonlyArray<ReadonlyArray<{ documentId: string }>>,
    options: RrfBlendOptions = {},
): RrfBlendResult[] {
    const k = options.k ?? 60;
    if (!Number.isFinite(k) || k < 0) {
        throw new RangeError(`rrfBlend: k must be a non-negative finite number (got ${k})`);
    }

    const scoreByDoc = new Map<string, number>();
    for (const list of rankings) {
        // Guard against accidental duplicates inside a single list —
        // a doc should only contribute one score per list, and the
        // first occurrence (best rank) wins.
        const seen = new Set<string>();
        for (let rank = 0; rank < list.length; rank++) {
            const id = list[rank].documentId;
            if (seen.has(id)) continue;
            seen.add(id);
            const contribution = 1 / (k + rank + 1);
            scoreByDoc.set(id, (scoreByDoc.get(id) ?? 0) + contribution);
        }
    }

    const merged: RrfBlendResult[] = [];
    for (const [documentId, score] of scoreByDoc) {
        merged.push({ documentId, score });
    }

    merged.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;
        // Stable tiebreak by id ASC — keeps test snapshots / search
        // palette ordering deterministic across runs.
        return a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0;
    });

    return merged;
}
