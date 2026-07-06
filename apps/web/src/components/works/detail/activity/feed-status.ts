/**
 * Client-side status filter for the work activity feed.
 *
 * The feed API (`FeedQueryDto`) only filters by category server-side, so the
 * status chips narrow the already-loaded entries in the browser. Kept in a
 * plain module (no 'use client') so the server page can import the list to
 * parse the `?status=` search param.
 */
export const FEED_STATUS_FILTERS = [
    'all',
    'in_progress',
    'completed',
    'pending',
    'failed',
    'cancelled',
] as const;

export type FeedStatusFilter = (typeof FEED_STATUS_FILTERS)[number];
