import type { FeedEntry } from './feed-entry.dto';

/**
 * Pull-mode degraded reason — populated only when `activitySyncMode = 'pull'`
 * and the platform's fetch against the deployed site failed. Push-mode and
 * disabled Works never set this field. The web client surfaces it via the
 * `DegradedBanner` component (EW-120).
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
