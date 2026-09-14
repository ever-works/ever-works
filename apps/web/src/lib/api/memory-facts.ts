import 'server-only';
import { serverFetch } from './server-api';
import {
    buildMemoryFactsQuery,
    EMPTY_MEMORY_FACT_LIST,
    type MemoryFactListDto,
    type MemoryFactsQuery,
    type MemoryFactStatsDto,
} from './memory-facts-types';

/**
 * Memory facts (AW-07) — server-only client for `/api/memory/facts`.
 *
 * Used by the Memory page's server component for the first page of facts.
 * `serverFetch` stamps the workspace selector from the incoming request, so
 * an `/org/<slug>/memory` render lists that Organization's facts. The client
 * panel re-queries the same-origin BFF (`/api/memory/facts`) through
 * `browserApiFetch` for search, paging and every write.
 */
export const memoryFactsAPI = {
    async list(query: MemoryFactsQuery = {}): Promise<MemoryFactListDto> {
        return serverFetch<MemoryFactListDto>(`/memory/facts${buildMemoryFactsQuery(query)}`, {
            method: 'GET',
        });
    },

    async stats(): Promise<MemoryFactStatsDto> {
        return serverFetch<MemoryFactStatsDto>('/memory/facts/stats', { method: 'GET' });
    },
};

export { EMPTY_MEMORY_FACT_LIST };
export type { MemoryFactListDto, MemoryFactsQuery, MemoryFactStatsDto };
