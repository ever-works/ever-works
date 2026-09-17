import { Injectable } from '@nestjs/common';
import {
    MEMORY_FACT_SEARCH_MIN_SCORE,
    MEMORY_FACT_SEARCH_TOP_K,
    cosineToNormalizedScore,
    normalizedScoreToCosine,
    type MemoryFactScope,
    type MemoryFactStatus,
} from '@ever-works/contracts';
import { MemoryFactRepository } from '../database/repositories/memory-fact.repository';
import type { OwnershipScope } from '../database/ownership-scope';
import type { MemoryFact } from '../entities/memory-fact.entity';
import { MemoryFactVectorIndexService } from './memory-fact-vector-index.service';

/** The filter a search runs inside — the same one the list view is showing. */
export interface MemoryFactSearchFilter {
    status: MemoryFactStatus;
    pinnedOnly?: boolean;
    scope?: MemoryFactScope;
    agentId?: string;
}

/** One ranked search result. */
export interface MemoryFactSearchHit {
    fact: MemoryFact;
    /** Cosine relevance in `[0, 1]`; `null` for a literal-only hit. */
    score: number | null;
    literalMatch: boolean;
}

export interface MemoryFactSearchResult {
    results: MemoryFactSearchHit[];
    /** `false` when meaning-based matching was not available for this query. */
    semantic: boolean;
}

/**
 * AW-07 — Facts search: meaning-based matching fused with literal matching.
 *
 * ## The fusion rule
 *
 *  1. **Literal leg** — case-insensitive substring over the body, inside the
 *     same filter the list is showing.
 *  2. **Semantic leg** — embed the query, ask the workspace's vector store
 *     for the nearest facts, keep hits at or above
 *     {@link MEMORY_FACT_SEARCH_MIN_SCORE} cosine similarity, and re-load them
 *     from the database with the caller's ownership predicate. A hit whose
 *     stored vector came from a different embedding model than the query's
 *     is dropped: two vector spaces are not comparable, and the sweep will
 *     re-embed it.
 *  3. **Fuse** — every literal hit is ALWAYS included, whatever its score.
 *     The remaining slots up to {@link MEMORY_FACT_SEARCH_TOP_K} go to the
 *     best semantic hits. Ranking is by cosine score, with a literal-only hit
 *     ranked as if it scored exactly the threshold — it matched the words the
 *     owner typed, which is at least as relevant as the weakest meaning match.
 *
 * ## Degraded mode
 *
 * No embedder, no vector store, a vendor error, or a query that takes the
 * semantic leg down for any reason: the result is the literal leg alone
 * with `semantic: false`, and the UI shows its "matching by exact words"
 * note. Search never throws for want of a provider.
 */
@Injectable()
export class MemoryFactSearchService {
    constructor(
        private readonly facts: MemoryFactRepository,
        private readonly vectors: MemoryFactVectorIndexService,
    ) {}

    async search(
        actor: { userId: string; ownership?: OwnershipScope },
        query: string,
        filter: MemoryFactSearchFilter,
    ): Promise<MemoryFactSearchResult> {
        const trimmed = query.trim();
        if (trimmed.length === 0) {
            return { results: [], semantic: false };
        }

        const literal = await this.facts.searchLiteral(actor.userId, actor.ownership, trimmed, {
            ...filter,
            limit: MEMORY_FACT_SEARCH_TOP_K,
        });

        const semantic = await this.semanticLeg(actor, trimmed, filter);
        if (!semantic.ok) {
            return {
                results: literal.map((fact) => ({ fact, score: null, literalMatch: true })),
                semantic: false,
            };
        }

        return { results: fuse(literal, semantic.hits), semantic: true };
    }

    private async semanticLeg(
        actor: { userId: string; ownership?: OwnershipScope },
        query: string,
        filter: MemoryFactSearchFilter,
    ): Promise<{ ok: true; hits: Array<{ fact: MemoryFact; score: number }> } | { ok: false }> {
        try {
            const embedding = await this.vectors.embed(query, actor.userId);
            if (!embedding.ok) return { ok: false };

            const key = {
                userId: actor.userId,
                organizationId: actor.ownership?.organizationId ?? null,
                tenantId: actor.ownership?.tenantId ?? null,
            };
            const queried = await this.vectors.query(
                key,
                embedding.value,
                MEMORY_FACT_SEARCH_TOP_K,
            );
            if (!queried.ok) return { ok: false };

            const minNormalized = cosineToNormalizedScore(MEMORY_FACT_SEARCH_MIN_SCORE);
            const bestById = new Map<string, number>();
            for (const hit of queried.value) {
                if (hit.normalizedScore < minNormalized) continue;
                const previous = bestById.get(hit.factId);
                if (previous === undefined || hit.normalizedScore > previous) {
                    bestById.set(hit.factId, hit.normalizedScore);
                }
            }
            if (bestById.size === 0) return { ok: true, hits: [] };

            // Re-load under the caller's ownership predicate: the database, not
            // the vector store, decides what this caller may see.
            const owned = await this.facts.findOwnedByIds(
                [...bestById.keys()],
                actor.userId,
                actor.ownership,
            );
            const hits = owned
                .filter((fact) => matchesFilter(fact, filter))
                .filter((fact) => fact.embeddedAt && fact.embeddingModel === embedding.value.model)
                .map((fact) => ({
                    fact,
                    score: normalizedScoreToCosine(bestById.get(fact.id) ?? 0),
                }));
            return { ok: true, hits };
        } catch {
            return { ok: false };
        }
    }
}

function matchesFilter(fact: MemoryFact, filter: MemoryFactSearchFilter): boolean {
    if (fact.status !== filter.status) return false;
    if (filter.pinnedOnly && !fact.pinned) return false;
    if (filter.scope && fact.scope !== filter.scope) return false;
    if (filter.agentId && fact.agentId !== filter.agentId) return false;
    return true;
}

/** Literal hits always in; best semantic hits fill the rest; rank by score. */
export function fuse(
    literal: MemoryFact[],
    semantic: Array<{ fact: MemoryFact; score: number }>,
): MemoryFactSearchHit[] {
    const byId = new Map<string, MemoryFactSearchHit>();
    const semanticScore = new Map(semantic.map((hit) => [hit.fact.id, hit.score]));

    for (const fact of literal) {
        byId.set(fact.id, {
            fact,
            score: semanticScore.get(fact.id) ?? null,
            literalMatch: true,
        });
    }

    const remaining = [...semantic]
        .filter((hit) => !byId.has(hit.fact.id))
        .sort((a, b) => b.score - a.score);
    for (const hit of remaining) {
        if (byId.size >= MEMORY_FACT_SEARCH_TOP_K) break;
        byId.set(hit.fact.id, { fact: hit.fact, score: hit.score, literalMatch: false });
    }

    const rankOf = (hit: MemoryFactSearchHit) => hit.score ?? MEMORY_FACT_SEARCH_MIN_SCORE;
    return [...byId.values()].sort((a, b) => {
        const delta = rankOf(b) - rankOf(a);
        if (delta !== 0) return delta;
        return timeOf(b.fact.createdAt) - timeOf(a.fact.createdAt);
    });
}

function timeOf(value: Date | string | undefined): number {
    if (!value) return 0;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}
