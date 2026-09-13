import { FEED_KINDS, FEED_MAX_AGENT_FILTER, type FeedKind } from '@ever-works/contracts';

/**
 * Live Feed filter state and its two persistence layers: the URL (so a
 * filtered view can be shared) and localStorage (so the last filters come
 * back on the next visit when the URL carries none). Pure — no React.
 */
export interface FeedFilterState {
    agentIds: string[];
    kinds: FeedKind[];
    failedOnly: boolean;
}

/** Query-string names. Distinct from every Activity log parameter. */
export const FEED_FILTER_PARAMS = {
    agents: 'agents',
    kinds: 'kinds',
    failed: 'failed',
} as const;

export const FEED_FILTER_STORAGE_KEY = 'activity-feed-filters';

export const EMPTY_FEED_FILTERS: FeedFilterState = { agentIds: [], kinds: [], failedOnly: false };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface SearchParamsLike {
    get(name: string): string | null;
    has(name: string): boolean;
}

function splitList(value: string | null | undefined): string[] {
    if (!value) return [];
    return value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
}

/** Keep only well-formed, de-duplicated values within the documented limits. */
export function normalizeFeedFilters(
    state: Partial<FeedFilterState> | null | undefined,
): FeedFilterState {
    const agentIds = [
        ...new Set((state?.agentIds ?? []).filter((id) => typeof id === 'string' && UUID.test(id))),
    ]
        .map((id) => id.toLowerCase())
        .slice(0, FEED_MAX_AGENT_FILTER);
    const requested = new Set(state?.kinds ?? []);
    const kinds = FEED_KINDS.filter((kind) => requested.has(kind));
    return { agentIds: [...new Set(agentIds)], kinds, failedOnly: state?.failedOnly === true };
}

export function hasFeedFilterParams(params: SearchParamsLike): boolean {
    return (
        params.has(FEED_FILTER_PARAMS.agents) ||
        params.has(FEED_FILTER_PARAMS.kinds) ||
        params.has(FEED_FILTER_PARAMS.failed)
    );
}

export function parseFeedFilters(params: SearchParamsLike): FeedFilterState {
    return normalizeFeedFilters({
        agentIds: splitList(params.get(FEED_FILTER_PARAMS.agents)),
        kinds: splitList(params.get(FEED_FILTER_PARAMS.kinds)) as FeedKind[],
        failedOnly: params.get(FEED_FILTER_PARAMS.failed) === '1',
    });
}

/** Filter state → the query-string pairs that represent it (empty when unfiltered). */
export function serializeFeedFilters(state: FeedFilterState): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    if (state.agentIds.length > 0)
        pairs.push([FEED_FILTER_PARAMS.agents, state.agentIds.join(',')]);
    if (state.kinds.length > 0) pairs.push([FEED_FILTER_PARAMS.kinds, state.kinds.join(',')]);
    if (state.failedOnly) pairs.push([FEED_FILTER_PARAMS.failed, '1']);
    return pairs;
}

export function feedFiltersToQuery(state: FeedFilterState): string {
    return new URLSearchParams(serializeFeedFilters(state)).toString();
}

export function isFeedFiltered(state: FeedFilterState): boolean {
    return state.agentIds.length > 0 || state.kinds.length > 0 || state.failedOnly;
}

export function sameFeedFilters(a: FeedFilterState, b: FeedFilterState): boolean {
    return feedFiltersToQuery(a) === feedFiltersToQuery(b);
}

/** Last-used filters; never throws (private mode, quota, corrupt JSON). */
export function readStoredFeedFilters(
    storage: Pick<Storage, 'getItem'> | undefined,
): FeedFilterState | null {
    if (!storage) return null;
    try {
        const raw = storage.getItem(FEED_FILTER_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<FeedFilterState>;
        return normalizeFeedFilters(parsed);
    } catch {
        return null;
    }
}

export function writeStoredFeedFilters(
    storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined,
    state: FeedFilterState,
): void {
    if (!storage) return;
    try {
        if (isFeedFiltered(state)) {
            storage.setItem(FEED_FILTER_STORAGE_KEY, JSON.stringify(state));
        } else {
            storage.removeItem(FEED_FILTER_STORAGE_KEY);
        }
    } catch {
        // Persisting filters is a convenience; the URL still carries them.
    }
}

export type ToggleAgentResult = { state: FeedFilterState; refused: boolean };

/** Toggle one agent, refusing (not truncating) a selection beyond the limit. */
export function toggleFeedAgent(state: FeedFilterState, agentId: string): ToggleAgentResult {
    if (state.agentIds.includes(agentId)) {
        return {
            state: { ...state, agentIds: state.agentIds.filter((id) => id !== agentId) },
            refused: false,
        };
    }
    if (state.agentIds.length >= FEED_MAX_AGENT_FILTER) {
        return { state, refused: true };
    }
    return { state: { ...state, agentIds: [...state.agentIds, agentId] }, refused: false };
}

export function toggleFeedKind(state: FeedFilterState, kind: FeedKind): FeedFilterState {
    const kinds = state.kinds.includes(kind)
        ? state.kinds.filter((k) => k !== kind)
        : [...state.kinds, kind];
    return { ...state, kinds: FEED_KINDS.filter((k) => kinds.includes(k)) };
}
