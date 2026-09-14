import 'server-only';
import type { HomeBlockId, HomeSummaryDto } from '@ever-works/contracts';
import { serverFetch } from './server-api';

/**
 * Home (AW-19) — typed server client for `GET /api/home/summary`.
 *
 * `serverFetch` attaches the session bearer and the active workspace scope
 * header, so the API bounds the summary by the owner and the selected scope;
 * nothing here can name another user or Organization. The path does not start
 * with `/api` — `API_URL` already ends in it.
 */
export interface HomeSummaryParams {
    /** The browser's IANA timezone; omitted = the profile timezone, else UTC. */
    tz?: string | null;
    /** Only these blocks (a per-block retry); omitted = every block. */
    blocks?: readonly HomeBlockId[];
}

export function buildHomeSummaryQuery(params: HomeSummaryParams = {}): string {
    const searchParams = new URLSearchParams();
    if (params.tz) searchParams.set('tz', params.tz);
    if (params.blocks && params.blocks.length > 0)
        searchParams.set('blocks', params.blocks.join(','));
    const query = searchParams.toString();
    return query ? `?${query}` : '';
}

export const homeAPI = {
    /**
     * The composed morning read. Rejects on any non-2xx response — a partial
     * object is never returned; block-level failures arrive inside a 200.
     */
    summary: async (params?: HomeSummaryParams): Promise<HomeSummaryDto> =>
        serverFetch<HomeSummaryDto>(`/home/summary${buildHomeSummaryQuery(params)}`, {
            method: 'GET',
        }),
};
