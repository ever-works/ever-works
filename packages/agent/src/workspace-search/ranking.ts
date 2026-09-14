import type { WorkspaceSearchKind, WorkspaceSearchMatchReason } from '@ever-works/contracts/api';
import { fold } from './fold';

/**
 * Pure ranking for the workspace search (AW-01 spec FR-14 / FR-15 / FR-16).
 *
 * No NestJS, no TypeORM: every score band, boost and tie-break is a plain
 * function of its inputs, so the table can be unit-tested exhaustively and
 * any back end (live fan-out today, an index later) ranks identically.
 */

/** Base score per match band (FR-14). */
export const MATCH_SCORES: Record<WorkspaceSearchMatchReason, number> = {
    exact: 100,
    prefix: 90,
    wordPrefix: 80,
    contains: 65,
    identifier: 60,
    secondary: 40,
    fuzzy: 25,
};

/** Added when the caller opened this exact record recently. */
export const RECENT_OPEN_BOOST = 10;
/** Added when the record changed within {@link FRESH_WINDOW_MS}. */
export const FRESHNESS_BOOST = 5;
export const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_SCORE = 100;
/**
 * Fuzzy (in-order subsequence) matching only applies from this many
 * characters — a two-letter subsequence matches nearly every title.
 */
export const FUZZY_MIN_QUERY_LENGTH = 3;

/**
 * Kind priority (FR-15). Commands and Screens live only in the web client,
 * so the server list starts at Missions; order otherwise follows the spec.
 */
export const KIND_PRIORITY: readonly WorkspaceSearchKind[] = [
    'mission',
    'task',
    'agent',
    'work',
    'idea',
    'skill',
    'team',
    'knowledge',
    'run',
    'decision',
    'memory',
    'goal',
    'meeting',
    'node',
    'connection',
];

export interface ScoreInput {
    /** The raw query as typed; folded internally. */
    query: string;
    title: string;
    identifier?: string | null;
    secondary?: ReadonlyArray<string | null | undefined>;
    /** True when the caller opened this record recently. */
    recentlyOpened?: boolean;
    updatedAt?: Date | null;
    now?: Date;
}

export interface ScoreResult {
    score: number;
    matchReason: WorkspaceSearchMatchReason;
}

/** True when every character of `needle` appears in `haystack` in order. */
export function isSubsequence(needle: string, haystack: string): boolean {
    if (!needle) return false;
    let index = 0;
    for (const char of haystack) {
        if (char === needle[index]) {
            index += 1;
            if (index === needle.length) return true;
        }
    }
    return false;
}

function hasWordStartingWith(text: string, query: string): boolean {
    return text.split(/[^\p{L}\p{N}]+/u).some((word) => word.length > 0 && word.startsWith(query));
}

function baseMatch(input: ScoreInput): WorkspaceSearchMatchReason | null {
    const query = fold(input.query);
    if (!query) return null;
    const title = fold(input.title);
    const identifier = fold(input.identifier);

    if (title === query || (identifier.length > 0 && identifier === query)) return 'exact';
    if (title.startsWith(query)) return 'prefix';
    if (hasWordStartingWith(title, query)) return 'wordPrefix';
    if (title.includes(query)) return 'contains';
    if (identifier.includes(query)) return 'identifier';
    if ((input.secondary ?? []).some((value) => fold(value).includes(query))) return 'secondary';
    if (query.length >= FUZZY_MIN_QUERY_LENGTH && isSubsequence(query.replace(/\s+/g, ''), title)) {
        return 'fuzzy';
    }
    return null;
}

/**
 * Score one candidate, or `null` when it does not match at all. Boosts are
 * additive and the result is capped at {@link MAX_SCORE}.
 */
export function scoreCandidate(input: ScoreInput): ScoreResult | null {
    const matchReason = baseMatch(input);
    if (!matchReason) return null;

    let score = MATCH_SCORES[matchReason];
    if (input.recentlyOpened) score += RECENT_OPEN_BOOST;
    if (input.updatedAt) {
        const now = (input.now ?? new Date()).getTime();
        const age = now - input.updatedAt.getTime();
        if (age >= 0 && age <= FRESH_WINDOW_MS) score += FRESHNESS_BOOST;
    }
    return { score: Math.min(score, MAX_SCORE), matchReason };
}

export interface RankableHit {
    kind: WorkspaceSearchKind;
    title: string;
    score: number;
    /** ISO 8601 or null. */
    updatedAt: string | null;
}

function kindRank(kind: WorkspaceSearchKind): number {
    const index = KIND_PRIORITY.indexOf(kind);
    return index === -1 ? KIND_PRIORITY.length : index;
}

/**
 * FR-15 tie-break chain: higher score → more recently changed → kind
 * priority → display name ascending (case-insensitive). Total and stable.
 */
export function compareHits(a: RankableHit, b: RankableHit): number {
    if (a.score !== b.score) return b.score - a.score;

    const aTime = a.updatedAt ? Date.parse(a.updatedAt) : Number.NEGATIVE_INFINITY;
    const bTime = b.updatedAt ? Date.parse(b.updatedAt) : Number.NEGATIVE_INFINITY;
    if (aTime !== bTime) return bTime > aTime ? 1 : -1;

    const kindDelta = kindRank(a.kind) - kindRank(b.kind);
    if (kindDelta !== 0) return kindDelta;

    const aName = fold(a.title);
    const bName = fold(b.title);
    if (aName === bName) return 0;
    return aName < bName ? -1 : 1;
}

export interface RankableGroup<H extends RankableHit> {
    kind: WorkspaceSearchKind;
    total: number;
    hits: H[];
}

export interface CutOptions {
    perKindLimit: number;
    limit: number;
}

/**
 * Sort each group's hits, cut each group to `perKindLimit`, order the groups
 * by kind priority with any group holding a score-100 hit promoted to the top
 * (FR-16), then cut the whole response to `limit` rows (FR-17). Empty groups
 * are dropped.
 */
export function orderAndCutGroups<H extends RankableHit>(
    groups: ReadonlyArray<RankableGroup<H>>,
    options: CutOptions,
): RankableGroup<H>[] {
    const sorted = groups
        .filter((group) => group.hits.length > 0)
        .map((group) => ({
            kind: group.kind,
            total: Math.max(group.total, group.hits.length),
            hits: [...group.hits].sort(compareHits).slice(0, options.perKindLimit),
        }));

    sorted.sort((a, b) => {
        const aExact = a.hits.some((hit) => hit.score >= MAX_SCORE) ? 0 : 1;
        const bExact = b.hits.some((hit) => hit.score >= MAX_SCORE) ? 0 : 1;
        if (aExact !== bExact) return aExact - bExact;
        return kindRank(a.kind) - kindRank(b.kind);
    });

    const out: RankableGroup<H>[] = [];
    let remaining = options.limit;
    for (const group of sorted) {
        if (remaining <= 0) break;
        const hits = group.hits.slice(0, remaining);
        remaining -= hits.length;
        out.push({ ...group, hits });
    }
    return out;
}
