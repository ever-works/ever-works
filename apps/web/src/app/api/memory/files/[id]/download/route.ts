import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../../proxy';

/**
 * Proxy — `GET /api/memory/files/:id/download` (binary passthrough).
 *
 * ─── KNOWN GAP (EW-786) — org-scoped Memory originals do not download ───
 *
 * This is the one route in the family that is org-aware and STILL
 * unscoped, and it is left that way on purpose.
 *
 * `MemoryFilesController.download` reads
 * `ScopeContextService.getOrganizationId()` and passes it into
 * `resolveBytes`. For `source=kb-upload` rows with no `workId` — i.e.
 * exactly the org-scoped Memory originals added through the Originals
 * panel — `WorkKnowledgeUploadRepository.findForMemoryFiles` only
 * matches when an `organizationId` is supplied, and `resolveBytes` then
 * re-checks membership before reading bytes. With no scope header the
 * row is invisible and the API answers `404 { status: 'error', message:
 * 'File not found' }`.
 *
 * So why not scope it? Because this URL is reached by BROWSER DOCUMENT
 * REQUESTS, which cannot carry a custom header:
 *
 *   1. the Download anchor in `MemoryFilesPanel.tsx` (`<a href=…>`);
 *   2. the same anchor inside the `MemoryFilePreview` overlay;
 *   3. the KB binary viewers (`KbPdfViewer`, `KbImageViewer`,
 *      `KbVideoViewer`, `KbAudioViewer`, …) which are handed this URL by
 *      `MemoryFilePreview` and put it on their own `<img src>` /
 *      `<video src>` / object element.
 *
 * `browserApiFetch` cannot reach any of those, and
 * `applyBffWorkspaceScope` THROWS without a selector — so scoping here
 * would turn a 404 on org originals into a 400 on every download,
 * including the personal chat uploads that work today. That is strictly
 * worse.
 *
 * What still works unscoped: `source=upload` rows (owner-gated by
 * `userId` through `UploadsService.readFile`) and `source=kb-upload`
 * rows that belong to a Work (re-checked against Work view access by
 * `userId`). What is broken: downloading or previewing an org-scoped
 * Memory original — and note that scoping the sibling `GET
 * /api/memory/files` list is what makes those rows VISIBLE in the Files
 * table in the first place, so the failure is now reachable where before
 * the rows simply never appeared.
 *
 * Carrying the scope some other way (a query parameter, an `/org/<slug>/`
 * path segment, a scope cookie) is a contract change to the API's
 * `X-Scope-Slug`-or-path rule from `8f28edca0` and a security decision
 * about a browser-tamperable channel on a bytes-serving endpoint. That
 * belongs to a human, not to this fix — do not invent one here.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return proxyMemoryFiles(request, `/memory/files/${encodeURIComponent(id)}/download`, {
        method: 'GET',
        scoped: false,
    });
}
