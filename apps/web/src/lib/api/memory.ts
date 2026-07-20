import 'server-only';
import { serverFetch } from './server-api';
import {
    buildMemoryQuery,
    EMPTY_MEMORY_RESPONSE,
    type MemoryFilters,
    type MemoryResponse,
} from './memory-types';

/**
 * Org-wide Memory (Cortex P1) — server-side client for the
 * `GET /api/memory` aggregation. Used by the Memory page's server
 * component for the initial render. The client shell re-queries the
 * same-origin BFF proxy (`/api/memory`) for interactive filtering.
 */
export const memoryAPI = {
    async get(filters: MemoryFilters = {}): Promise<MemoryResponse> {
        return serverFetch<MemoryResponse>(`/memory${buildMemoryQuery(filters)}`, {
            method: 'GET',
        });
    },
};

export { EMPTY_MEMORY_RESPONSE };
export type { MemoryFilters, MemoryResponse };
