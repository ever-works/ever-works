import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../../../proxy';

/**
 * Proxy — `POST /api/memory/files/folders/:id/sync` (manual "Sync now").
 *
 * Scoped (EW-786): `MemoryFilesController.syncFolder` takes the
 * Organization from the request scope context and threads it through the
 * sync walk's byte reader (`readFileBytes` → `resolveBytes`), so an
 * unscoped sync silently skipped — or failed to read — every org-scoped
 * Memory original in the folder while reporting success for the rest.
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return proxyMemoryFiles(request, `/memory/files/folders/${encodeURIComponent(id)}/sync`, {
        method: 'POST',
        body: null,
        scoped: true,
    });
}
