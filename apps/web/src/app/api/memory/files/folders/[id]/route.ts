import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../../proxy';

/**
 * Proxy — `PATCH` / `DELETE /api/memory/files/folders/:id`.
 *
 * NOT scoped (EW-786): both `MemoryFilesController.updateFolder` (rename
 * / move / git-sync target) and `.deleteFolder` operate purely on
 * `MemoryFoldersService` with `auth.userId`. The Organization only
 * enters the picture when the folder's CONTENTS are read, which is the
 * separately scoped `folders/:id/sync` route.
 */

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return proxyMemoryFiles(request, `/memory/files/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: request.body,
        scoped: false,
    });
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return proxyMemoryFiles(request, `/memory/files/folders/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        scoped: false,
    });
}
