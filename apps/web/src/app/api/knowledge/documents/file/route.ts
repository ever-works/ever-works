import { bffProxy } from '@/lib/api/bff-proxy';
import { relayKnowledge } from '../../proxy';

/**
 * Proxy — `PATCH /api/knowledge/documents/file` (file up to 100 documents
 * into a shared folder, or `folderId: null` to unfile them).
 *
 * Scoped: the API only accepts a folder of the Organization in scope, and
 * answers a document outside it with 404.
 */
export const PATCH = bffProxy((scoped) =>
    relayKnowledge(scoped, '/knowledge/documents/file', { method: 'PATCH', withBody: true }),
);
