/**
 * Client-safe types + constants for the EW-120 Activity Feed.
 *
 * Kept separate from `activity-feed.ts` (which is `server-only`) so client
 * components and Vitest tests can import the type discriminants without
 * pulling the `serverFetch` chain.
 *
 * Source of truth (mirrored by hand): `apps/api/src/works/activity-feed/dto/feed-entry.dto.ts`.
 */

export type FeedCategory =
    | 'all'
    | 'generation'
    | 'items'
    | 'deployment'
    | 'settings'
    | 'comparisons'
    | 'communityPr'
    | 'users'
    | 'submissions'
    | 'reports';

export const FEED_CATEGORIES: readonly FeedCategory[] = [
    'all',
    'generation',
    'items',
    'deployment',
    'settings',
    'comparisons',
    'communityPr',
    'users',
    'submissions',
    'reports',
];

interface FeedEntryBase {
    id: string;
    timestamp: string;
    category: FeedCategory;
    summary: string;
}

export interface PlatformActivityLogEntry extends FeedEntryBase {
    source: 'platform-activity-log';
    type: string;
    status: string;
    details?: Record<string, unknown> | null;
}

export interface GenerationHistoryEntry extends FeedEntryBase {
    source: 'generation-history';
    type: string;
    status: string;
    runId: string;
    newItemsCount: number;
    updatedItemsCount: number;
    totalItemsCount: number;
    durationInSeconds?: number | null;
}

export type FeedEntry = PlatformActivityLogEntry | GenerationHistoryEntry;

export interface FeedResponse {
    entries: FeedEntry[];
    nextCursor?: string | null;
    serverTime: string;
}

export interface GetActivityFeedParams {
    cursor?: string;
    limit?: number;
    category?: FeedCategory;
}
