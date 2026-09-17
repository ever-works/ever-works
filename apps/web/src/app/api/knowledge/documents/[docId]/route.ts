import { bffProxy } from '@/lib/api/bff-proxy';
import { relayKnowledge } from '../../proxy';

type RouteContext = { params: Promise<{ docId: string }> };

/**
 * Proxy — `GET /api/knowledge/documents/:docId` (one document as a shelf
 * row). The per-Work workbench header reads it for the folder breadcrumb and
 * to know whether the File / Archive / Restore controls are enabled.
 */
export const GET = bffProxy<RouteContext>(async (scoped, { params }) => {
    const { docId } = await params;
    return relayKnowledge(scoped, `/knowledge/documents/${encodeURIComponent(docId)}`, {
        method: 'GET',
    });
});
