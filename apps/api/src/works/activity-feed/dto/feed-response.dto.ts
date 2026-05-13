import type { FeedEntry } from './feed-entry.dto';

export interface FeedResponse {
    entries: FeedEntry[];
    nextCursor?: string | null;
    serverTime: string;
}
