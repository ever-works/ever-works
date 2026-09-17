import { bffProxy } from '@/lib/api/bff-proxy';
import { relayKnowledge } from '../proxy';

/**
 * Proxy — `GET /api/knowledge/library` (one page of the shelf).
 *
 * Scoped: the Organization whose shelf is listed comes from the request scope
 * context upstream, so the per-tab selector must travel. The filters
 * (`folderId`, `archived`, `q`, `class`, `workId`, `sort`, `limit`, `cursor`)
 * are forwarded untouched and validated by the API.
 */
export const GET = bffProxy((scoped) =>
    relayKnowledge(scoped, '/knowledge/library', { method: 'GET' }),
);
