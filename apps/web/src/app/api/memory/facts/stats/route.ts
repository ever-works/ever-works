import { bffProxy } from '@/lib/api/bff-proxy';
import { forwardMemoryFacts } from '../proxy';

/** Proxy — `GET /api/memory/facts/stats` (counts, capacities, semantic availability). */
export const GET = bffProxy(async ({ request, headers }) =>
    forwardMemoryFacts(request, headers, '/memory/facts/stats', 'GET'),
);
