import 'server-only';
import { serverFetch } from '../server-api';
import type { FeedResponse, GetActivityFeedParams } from './activity-feed.types';

export * from './activity-feed.types';

export const activityFeedAPI = {
    get: async (workId: string, params?: GetActivityFeedParams): Promise<FeedResponse> => {
        const search = new URLSearchParams();
        if (params?.cursor) search.set('cursor', params.cursor);
        if (params?.limit !== undefined) search.set('limit', String(params.limit));
        if (params?.category) search.set('category', params.category);
        const query = search.toString();
        return serverFetch<FeedResponse>(
            `/works/${workId}/activity-feed${query ? `?${query}` : ''}`,
        );
    },
};
