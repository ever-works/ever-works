import 'server-only';
import type { FeedActorsDto, FeedPageDto } from '@ever-works/contracts';
import { serverFetch } from './server-api';

/**
 * Live Feed — typed server client for `GET /api/feed` and
 * `GET /api/feed/actors`. `serverFetch` attaches the session bearer and the
 * active workspace scope header, so the API bounds every read by the owner
 * and the selected scope; nothing here can name another user.
 */
export interface GetFeedPageParams {
    agentIds?: readonly string[];
    kinds?: readonly string[];
    failedOnly?: boolean;
    cursor?: string | null;
    limit?: number;
}

export function buildFeedPageQuery(params: GetFeedPageParams = {}): string {
    const searchParams = new URLSearchParams();
    if (params.agentIds && params.agentIds.length > 0) {
        searchParams.set('agentIds', params.agentIds.join(','));
    }
    if (params.kinds && params.kinds.length > 0) {
        searchParams.set('kinds', params.kinds.join(','));
    }
    if (params.failedOnly) searchParams.set('failedOnly', 'true');
    if (params.cursor) searchParams.set('cursor', params.cursor);
    if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
    const query = searchParams.toString();
    return query ? `?${query}` : '';
}

export const feedAPI = {
    page: async (params?: GetFeedPageParams): Promise<FeedPageDto> =>
        serverFetch<FeedPageDto>(`/feed${buildFeedPageQuery(params)}`),

    actors: async (windowHours?: number): Promise<FeedActorsDto> =>
        serverFetch<FeedActorsDto>(
            `/feed/actors${windowHours !== undefined ? `?windowHours=${encodeURIComponent(String(windowHours))}` : ''}`,
        ),
};
