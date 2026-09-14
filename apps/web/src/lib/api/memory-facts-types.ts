/**
 * Memory facts (AW-07) — client-safe types and pure helpers.
 *
 * No `server-only` import here, so `'use client'` components can use these
 * alongside the server client in `memory-facts.ts`. The wire shapes and every
 * limit come from `@ever-works/contracts` — the API validates against the
 * same values, so the composer's character counter and the API's refusal can
 * never disagree about what 500 means.
 */
import type {
    MemoryFactCounts,
    MemoryFactDto,
    MemoryFactListDto,
    MemoryFactScope,
    MemoryFactStatsDto,
    MemoryFactStatus,
} from '@ever-works/contracts';

export type {
    MemoryFactCounts,
    MemoryFactDto,
    MemoryFactListDto,
    MemoryFactScope,
    MemoryFactStatsDto,
    MemoryFactStatus,
};

export {
    MEMORY_FACT_ACTIVE_MAX,
    MEMORY_FACT_BODY_MAX,
    MEMORY_FACT_FORGET_ALL_CONFIRMATION,
    MEMORY_FACT_FORGET_RETENTION_DAYS,
    MEMORY_FACT_LIST_LIMIT_MAX,
    MEMORY_FACT_PINNED_MAX,
} from '@ever-works/contracts';

/** The four views of the Facts list. `all` is every ACTIVE fact. */
export const MEMORY_FACT_VIEWS = ['all', 'pinned', 'proposed', 'forgotten'] as const;
export type MemoryFactView = (typeof MEMORY_FACT_VIEWS)[number];

/** Query parameters for `GET /api/memory/facts`. */
export interface MemoryFactsQuery {
    q?: string;
    view?: MemoryFactView;
    limit?: number;
    cursor?: string;
}

/** Map a view onto the API's status / pinned filter. */
export function viewFilter(view: MemoryFactView = 'all'): {
    status: MemoryFactStatus;
    pinnedOnly: boolean;
} {
    switch (view) {
        case 'pinned':
            return { status: 'active', pinnedOnly: true };
        case 'proposed':
            return { status: 'proposed', pinnedOnly: false };
        case 'forgotten':
            return { status: 'forgotten', pinnedOnly: false };
        default:
            return { status: 'active', pinnedOnly: false };
    }
}

/** Build the `?…` query string for a Facts request. Empty values are omitted. */
export function buildMemoryFactsQuery(query: MemoryFactsQuery = {}): string {
    const params = new URLSearchParams();
    const q = query.q?.trim();
    if (q) params.set('q', q);
    const { status, pinnedOnly } = viewFilter(query.view);
    params.set('status', status);
    if (pinnedOnly) params.set('pinnedOnly', 'true');
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    return `?${params.toString()}`;
}

/** The view a fact belongs to, for moving a row between lists optimistically. */
export function viewOfFact(fact: Pick<MemoryFactDto, 'status' | 'pinned'>): MemoryFactView {
    if (fact.status === 'proposed') return 'proposed';
    if (fact.status === 'forgotten') return 'forgotten';
    return 'all';
}

/** Zero counts, for an empty workspace or a failed first fetch. */
export const EMPTY_MEMORY_FACT_COUNTS: MemoryFactCounts = {
    active: 0,
    proposed: 0,
    forgotten: 0,
    pinned: 0,
};

/** The list payload the page renders when the first fetch fails. */
export const EMPTY_MEMORY_FACT_LIST: MemoryFactListDto = {
    facts: [],
    total: 0,
    counts: EMPTY_MEMORY_FACT_COUNTS,
    semantic: false,
};

/** The first page of facts as the page hands it to the panel. */
export interface InitialMemoryFacts {
    facts: MemoryFactListDto;
    /**
     * `true` when the server-side fetch failed. `facts` is then the empty
     * placeholder, and the panel must say the load failed (with Retry) rather
     * than present the workspace as having no facts.
     */
    loadFailed: boolean;
}

/**
 * Settle the server-side first-page fetch without ever rejecting — the page
 * must not 500 on a flaky API — while keeping "it failed" distinct from "it
 * is empty".
 */
export async function settleInitialMemoryFacts(
    load: Promise<MemoryFactListDto>,
): Promise<InitialMemoryFacts> {
    try {
        return { facts: await load, loadFailed: false };
    } catch {
        return { facts: EMPTY_MEMORY_FACT_LIST, loadFailed: true };
    }
}

/**
 * Pull the human message out of an API refusal body (`{ message }`, Nest's
 * `{ message: string | string[] }`, or a nested `{ message: { message } }`).
 * Returns `null` when there is nothing presentable, so the caller can fall
 * back to its own translated copy.
 */
export function refusalMessage(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
    if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
    if (message && typeof message === 'object') return refusalMessage(message);
    return null;
}
