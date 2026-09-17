import { bffProxy } from '@/lib/api/bff-proxy';
import { relayKnowledge } from '../../../proxy';

type RouteContext = { params: Promise<{ docId: string }> };

/**
 * Proxy — `POST /api/knowledge/documents/:docId/unarchive`. Restores an
 * archived document to the folder it was archived from; the response's
 * `restoredToUnfiled` says when that folder no longer exists. Not the
 * per-Work `/restore`, which restores a body from a Git commit.
 */
export const POST = bffProxy<RouteContext>(async (scoped, { params }) => {
    const { docId } = await params;
    return relayKnowledge(scoped, `/knowledge/documents/${encodeURIComponent(docId)}/unarchive`, {
        method: 'POST',
    });
});
