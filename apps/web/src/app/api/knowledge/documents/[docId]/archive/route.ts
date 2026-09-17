import { bffProxy } from '@/lib/api/bff-proxy';
import { relayKnowledge } from '../../../proxy';

type RouteContext = { params: Promise<{ docId: string }> };

/**
 * Proxy — `POST /api/knowledge/documents/:docId/archive`. Archiving never
 * deletes: the document leaves the default shelf and agent context but stays
 * readable and keeps its folder.
 */
export const POST = bffProxy<RouteContext>(async (scoped, { params }) => {
    const { docId } = await params;
    return relayKnowledge(scoped, `/knowledge/documents/${encodeURIComponent(docId)}/archive`, {
        method: 'POST',
    });
});
