import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../../proxy';
import { upstreamSearchWithoutScope } from '@/lib/api/bff-scope';

/**
 * Proxy — `PATCH` / `DELETE /api/memory/files/folders/:id`.
 *
 * NOT scoped (EW-786) for a personal folder: both
 * `MemoryFilesController.updateFolder` (rename / move / git-sync target) and
 * `.deleteFolder` operate purely on `MemoryFoldersService` with
 * `auth.userId`. The Organization only enters the picture when the folder's
 * CONTENTS are read, which is the separately scoped `folders/:id/sync` route.
 *
 * `?scope=organization` marks a Knowledge library shared folder. The handler
 * looks that id up among the shared folders of the Organization in scope, so
 * the call carries the per-tab selector, and the marker is consumed here —
 * the API's DELETE query DTO does not accept `scope`.
 */

function sharedInit(request: NextRequest) {
    if (request.nextUrl.searchParams.get('scope') !== 'organization') {
        return { scoped: false as const };
    }
    return {
        scoped: true as const,
        upstreamSearch: upstreamSearchWithoutScope(request.nextUrl.searchParams),
    };
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return proxyMemoryFiles(request, `/memory/files/folders/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: request.body,
        ...sharedInit(request),
    });
}

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
    const { id } = await ctx.params;
    return proxyMemoryFiles(request, `/memory/files/folders/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        ...sharedInit(request),
    });
}
