import type { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import type { WorkHistoryActivityType } from '@ever-works/contracts/api';

/**
 * Categories surfaced as filter chips in the Activity Feed UI. Maps to a set
 * of `type` values across the two sources (platform activity-log, work
 * generation history). Website-sourced events (users/submissions/reports) are
 * ingested into the platform activity-log via the EW-120 push endpoint.
 * See `ActivityFeedService.compose`.
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

/**
 * Discriminated union normalising the feed sources into a single shape the web
 * client can render uniformly.
 */
export type FeedEntry = PlatformActivityLogEntry | GenerationHistoryEntry;

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
