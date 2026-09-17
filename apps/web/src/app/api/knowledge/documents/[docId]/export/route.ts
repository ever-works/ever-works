import { bffProxy } from '@/lib/api/bff-proxy';
import { relayKnowledge } from '../../../proxy';

type RouteContext = { params: Promise<{ docId: string }> };

/**
 * Proxy — `GET /api/knowledge/documents/:docId/export?format=md`.
 *
 * Reached by `browserApiFetch` (the panel turns the response into a download),
 * not by a document navigation, so it carries the selector as a header like
 * the rest of the family. The Markdown body and its
 * `Content-Disposition: attachment; filename="<slug>.md"` are relayed as-is.
 */
export const GET = bffProxy<RouteContext>(async (scoped, { params }) => {
    const { docId } = await params;
    return relayKnowledge(scoped, `/knowledge/documents/${encodeURIComponent(docId)}/export`, {
        method: 'GET',
    });
});
