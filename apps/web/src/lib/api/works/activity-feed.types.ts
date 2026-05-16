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
    | 'reports'
    | 'sync';

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
    // EW-628 — Sync chip surfaces the `data_sync_*` activity rows
    // emitted by `DataSyncService.runDataSync` (G3) / dispatcher (G7).
    'sync',
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

/**
 * Pull-mode entry produced by `DirectoryWebsiteClient` after an HMAC-signed
 * fetch against the deployed directory site. Only appears in feeds for Works
 * whose `activitySyncMode === 'pull'`; push-mode equivalents arrive as
 * ordinary `platform-activity-log` rows via the ingest endpoint.
 */
export interface DirectorySiteEntry extends FeedEntryBase {
    source: 'directory-site';
    type: 'user_registered' | 'item_created' | 'item_status_changed' | 'report_created';
    actor: { id: string; name: string; email?: string | null } | null;
    target: { id: string; type: 'user' | 'item' | 'report'; name: string; adminUrl: string };
}

export type FeedEntry = PlatformActivityLogEntry | GenerationHistoryEntry | DirectorySiteEntry;

/**
 * Pull-mode degraded reason — set by the platform aggregator when the
 * HMAC-signed fetch against the deployed site failed. Push-mode and disabled
 * Works never populate this field; the banner only renders for pull-mode.
 */
export interface FeedDegradedReason {
    reason:
        | 'not_provisioned'
        | 'disabled'
        | 'timeout'
        | 'unauthorized'
        | 'upstream_5xx'
        | 'network'
        | 'parse_error';
    detail?: string;
    lastSuccessAt?: string | null;
}

export interface FeedResponse {
    entries: FeedEntry[];
    nextCursor?: string | null;
    serverTime: string;
    degraded?: {
        directorySite?: FeedDegradedReason;
    };
}

export interface GetActivityFeedParams {
    cursor?: string;
    limit?: number;
    category?: FeedCategory;
}
