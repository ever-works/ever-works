import type { FeedEntry } from './feed-entry.dto';

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
