import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../../proxy';

/**
 * Proxy — `GET /api/memory/files/:id/download` (binary passthrough).
 *
 * The one route in the family reached by BROWSER DOCUMENT REQUESTS rather
 * than `browserApiFetch`: the Download anchor in `MemoryFilesPanel`, the
 * same anchor in the `MemoryFilePreview` overlay, and the KB binary viewers
 * that put this URL on their own `<img src>` / `<video src>` / `<iframe
 * src>`. None of those can carry `x-ever-workspace`, so the selector travels
 * as `?scope=` instead (`memoryFileDownloadUrl` builds every one of those
 * URLs) and `proxyMemoryFiles` reads it back with
 * `applyBffWorkspaceScopeFromNavigation`:
 *
 *   - `?scope=personal` | `?scope=org:<slug>` → `X-Scope-Slug`, validated
 *     with the same grammar as the header, and checked against the page
 *     the link sat on (Referer) so a copied-and-edited URL fails closed;
 *   - no selector at all → personal, which is what every link predating
 *     the carrier got, and what still resolves `source=upload` rows and
 *     Work-owned `kb-upload` rows (both owner-gated by `userId` upstream);
 *   - a present-but-invalid selector → 400, never forwarded;
 *   - the carrier is stripped from the upstream query — the API's
 *     `DownloadMemoryFileQueryDto` only knows `source`.
 *
 * What this fixes: org-scoped Memory originals (`kb-upload` rows with no
 * `workId`) only resolve when `MemoryFilesController.download` sees an
 * Organization, and they became VISIBLE in the Files table once the list
 * route was scoped — so they were listed and then 404'd on download.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return proxyMemoryFiles(request, `/memory/files/${encodeURIComponent(id)}/download`, {
        method: 'GET',
        scoped: 'navigation',
    });
}
