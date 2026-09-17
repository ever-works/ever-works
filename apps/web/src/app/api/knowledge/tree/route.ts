import { bffProxy } from '@/lib/api/bff-proxy';
import { relayKnowledge } from '../proxy';

/**
 * Proxy — `GET /api/knowledge/tree` (the folder rail: shared folders with
 * document counts, the Unfiled and Archived totals, and whether the caller
 * may manage shared folders). Scoped to the tab's Organization.
 */
export const GET = bffProxy((scoped) =>
    relayKnowledge(scoped, '/knowledge/tree', { method: 'GET' }),
);
