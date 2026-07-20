/**
 * Org-wide Memory (Cortex P1) — wire types for the `GET /api/memory`
 * aggregation surface. Kept in a `server-only`-FREE module so BOTH the
 * server component (`memory.ts`, which wraps `serverFetch`) and the
 * client shell (which fetches the same-origin BFF proxy) can share them.
 *
 * Mirrors `OrgMemoryAggregateResult` on the API side
 * (`packages/agent/src/services/knowledge-base.service.ts`). Kept in
 * lockstep manually — the web consumes the contract and we don't want a
 * runtime dep on the agent package from `apps/web`. Wire dates are ISO
 * strings (NestJS class-transformer default).
 */

/** One row in the aggregated Memory feed (metadata only — no body). */
export interface MemoryDocument {
    id: string;
    title: string;
    description: string | null;
    path: string;
    /** Null for org-scoped documents. */
    workId: string | null;
    /** Display name of the source Work; null for org-scoped documents. */
    workName: string | null;
    /** KB document class (brand | legal | seo | style | glossary | …). */
    class: string;
    status: string;
    source: string;
    updatedAt: string;
    lastIndexedAt: string | null;
}

/** A facet bucket backing a filter chip. */
export interface MemoryFacet {
    value: string;
    label: string;
    count: number;
}

/** The `GET /api/memory` response payload. */
export interface MemoryResponse {
    documents: MemoryDocument[];
    /**
     * `documents` = total matching the active filters + search (drives the
     * empty-state copy). `indexed` = org-wide total ignoring filters +
     * search (drives the stable "documents indexed" header count).
     */
    counts: { documents: number; indexed: number };
    facets: {
        types: MemoryFacet[];
        works: MemoryFacet[];
        statuses: MemoryFacet[];
        sources: MemoryFacet[];
    };
}

/** Client-side filter selections that map to `GET /api/memory` params. */
export interface MemoryFilters {
    q?: string;
    type?: string[];
    work?: string[];
    status?: string[];
    source?: string[];
    limit?: number;
    offset?: number;
}

/** The empty payload rendered when there is no active Organization. */
export const EMPTY_MEMORY_RESPONSE: MemoryResponse = {
    documents: [],
    counts: { documents: 0, indexed: 0 },
    facets: { types: [], works: [], statuses: [], sources: [] },
};

/**
 * Build the `GET /api/memory` query string from filter selections.
 * Multi-value facets are sent as repeated params. Shared by the server
 * client and the client shell so both encode filters identically.
 */
export function buildMemoryQuery(filters: MemoryFilters = {}): string {
    const params = new URLSearchParams();
    if (filters.q) params.set('q', filters.q);
    for (const t of filters.type ?? []) params.append('type', t);
    for (const w of filters.work ?? []) params.append('work', w);
    for (const s of filters.status ?? []) params.append('status', s);
    for (const s of filters.source ?? []) params.append('source', s);
    if (filters.limit !== undefined) params.set('limit', String(filters.limit));
    if (filters.offset !== undefined) params.set('offset', String(filters.offset));
    const qs = params.toString();
    return qs ? `?${qs}` : '';
}
