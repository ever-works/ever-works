import 'server-only';
import { cache } from 'react';
import type {
    ChangelogCategory,
    ChangelogEntryDto,
    ChangelogListResponseDto,
    ChangelogMarkReadResponseDto,
    ChangelogUnreadCountResponseDto,
} from '@ever-works/contracts/api';
import { serverFetch, serverMutation } from './server-api';

/**
 * What's new (AW-14) — typed server-side client for `/api/changelog/*`.
 *
 * The wire types come from `@ever-works/contracts/api`, shared with the API,
 * so this module never redeclares them.
 *
 * Entries and read state are per person and never workspace-scoped on the
 * API side, so the scope header `serverFetch` attaches is simply ignored
 * there.
 */

export interface ChangelogListParams {
    category?: ChangelogCategory;
    limit?: number;
    cursor?: string;
}

export const changelogAPI = {
    /** One page of entries plus the unfiltered unread count. */
    list: async (params: ChangelogListParams = {}): Promise<ChangelogListResponseDto> => {
        const searchParams = new URLSearchParams();
        if (params.category) {
            searchParams.set('category', params.category);
        }
        if (params.limit !== undefined) {
            searchParams.set('limit', String(params.limit));
        }
        if (params.cursor) {
            searchParams.set('cursor', params.cursor);
        }
        const query = searchParams.toString();
        return serverFetch<ChangelogListResponseDto>(`/changelog${query ? `?${query}` : ''}`);
    },

    /** One entry by slug. Rejects with a 404 for an entry this build does not serve. */
    get: async (slug: string): Promise<ChangelogEntryDto> => {
        return serverFetch<ChangelogEntryDto>(`/changelog/${encodeURIComponent(slug)}`);
    },

    /**
     * The reader's unread count for the top-bar badge, fetched once per
     * dashboard shell render (deduped via `React.cache`). Returns `null` on
     * ANY failure — the control then renders with no badge and the shell is
     * never blocked or errored by a changelog count (spec FR-47, S-11).
     *
     * The count is per person, so it is deliberately NOT placed in the shared
     * Next data cache: `serverFetch` requests `no-store`. That keeps a
     * mark-all-read visible on the very next page load instead of up to five
     * minutes later, and is within FR-31's "at most 300 s" cache ceiling.
     */
    unreadCount: cache(async (): Promise<number | null> => {
        try {
            const response =
                await serverFetch<ChangelogUnreadCountResponseDto>('/changelog/unread-count');
            return typeof response?.count === 'number' && Number.isFinite(response.count)
                ? response.count
                : null;
        } catch {
            return null;
        }
    }),

    /** Record entries as read (1–25 slugs). Idempotent. */
    markRead: async (slugs: string[]): Promise<ChangelogMarkReadResponseDto> => {
        return serverMutation<ChangelogMarkReadResponseDto>({
            endpoint: '/changelog/read',
            method: 'POST',
            data: { slugs },
            wrapInData: false,
        });
    },

    /** Mark every visible entry read, regardless of any filter. Idempotent. */
    markAllRead: async (): Promise<ChangelogMarkReadResponseDto> => {
        return serverMutation<ChangelogMarkReadResponseDto>({
            endpoint: '/changelog/read-all',
            method: 'POST',
            data: {},
            wrapInData: false,
        });
    },
};
