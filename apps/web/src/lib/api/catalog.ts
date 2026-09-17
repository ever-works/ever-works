import 'server-only';
import type {
    PlaybookCategory,
    PlaybookDetailResponse,
    PlaybookListResponse,
    PlaybookPreflightReport,
} from '@ever-works/contracts';
import { serverFetch, serverMutation } from './server-api';
import { toApiResult } from './api-result';

export interface PlaybookListQuery {
    category?: PlaybookCategory;
    search?: string;
    readiness?: 'ready' | 'needs_connection' | 'adopted';
    limit?: number;
    offset?: number;
}

/**
 * Capability & playbook catalogue (AW-21) — server-side client for
 * `/api/catalog/playbooks*`. Every method resolves to an `ApiResult`, so a
 * failing catalogue renders its own section error instead of throwing the
 * page. The other catalogue sections use their own existing clients.
 */
export const catalogAPI = {
    listPlaybooks(query: PlaybookListQuery = {}) {
        const params = new URLSearchParams();
        if (query.category) params.set('category', query.category);
        if (query.search) params.set('search', query.search);
        if (query.readiness) params.set('readiness', query.readiness);
        if (query.limit !== undefined) params.set('limit', String(query.limit));
        if (query.offset !== undefined) params.set('offset', String(query.offset));
        const qs = params.toString();
        return toApiResult(() =>
            serverFetch<PlaybookListResponse>(`/catalog/playbooks${qs ? `?${qs}` : ''}`, {
                method: 'GET',
            }),
        );
    },

    getPlaybook(slug: string) {
        return toApiResult(() =>
            serverFetch<PlaybookDetailResponse>(`/catalog/playbooks/${encodeURIComponent(slug)}`, {
                method: 'GET',
            }),
        );
    },

    preflight(slug: string, body: { workId?: string; instanceName?: string } = {}) {
        return toApiResult(() =>
            serverMutation<PlaybookPreflightReport>({
                endpoint: `/catalog/playbooks/${encodeURIComponent(slug)}/preflight`,
                data: body,
                method: 'POST',
                wrapInData: false,
            }),
        );
    },
};
