import type { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import type { WorkHistoryActivityType } from '@ever-works/contracts/api';

/**
 * Categories surfaced as filter chips in the Activity Feed UI. Maps to a set
 * of `type` values across the active feed sources (platform activity-log,
 * work generation history, deployed-site events). The per-Work
 * `activitySyncMode` (pull / push / disabled — EW-120) decides which of the
 * website-sourced category populations is live. See
 * `ActivityFeedService.compose`.
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
    'sync',
];

/**
 * Discriminated union normalising the feed sources into a single shape the web
 * client can render uniformly. `directory-site` entries only appear in
 * pull-mode (`activitySyncMode === 'pull'`); push-mode rows arrive as ordinary
 * `platform-activity-log` entries via the `/api/activity-log/ingest`
 * endpoint.
 */
export type FeedEntry = PlatformActivityLogEntry | GenerationHistoryEntry | DirectorySiteEntry;

interface FeedEntryBase {
    id: string;
    timestamp: string;
    category: FeedCategory;
    summary: string;
}

export interface PlatformActivityLogEntry extends FeedEntryBase {
    source: 'platform-activity-log';
    type: ActivityActionType;
    status: ActivityStatus;
    details?: Record<string, unknown> | null;
}

export interface GenerationHistoryEntry extends FeedEntryBase {
    source: 'generation-history';
    type: WorkHistoryActivityType;
    status: string;
    runId: string;
    newItemsCount: number;
    updatedItemsCount: number;
    totalItemsCount: number;
    durationInSeconds?: number | null;
}

/**
 * Pull-mode entry produced by `DirectoryWebsiteClient` after an HMAC-signed
 * fetch against the deployed directory site's `/api/platform/activity-feed`
 * endpoint. The link target is the deployed site's admin URL (operator-side
 * click-through), not a platform route.
 */
export interface DirectorySiteEntry extends FeedEntryBase {
    source: 'directory-site';
    type: 'user_registered' | 'item_created' | 'item_status_changed' | 'report_created';
    actor: { id: string; name: string; email?: string | null } | null;
    target: { id: string; type: 'user' | 'item' | 'report'; name: string; adminUrl: string };
}
