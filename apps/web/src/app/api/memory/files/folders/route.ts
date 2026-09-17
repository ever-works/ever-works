import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../proxy';

/**
 * Proxy — `POST /api/memory/files/folders` (create folder).
 *
 * NOT scoped (EW-786) for a personal folder: `MemoryFilesController.createFolder`
 * delegates to `MemoryFoldersService.createFolder(auth.userId, …)`. Folders
 * are per-user, not per-Organization — see `tree/route.ts`.
 *
 * A body with `scope: 'organization'` creates a Knowledge library shared
 * folder in the Organization in scope, so that call alone carries the per-tab
 * selector. The body is peeked on a clone and still streamed upstream as-is.
 */
export async function POST(request: NextRequest) {
    // Peek BEFORE touching `request.body`: cloning tees the stream and swaps
    // the request's body for one branch, so a stream reference taken earlier
    // would be locked by the tee.
    const scoped = await isSharedFolderBody(request);
    return proxyMemoryFiles(request, '/memory/files/folders', {
        method: 'POST',
        body: request.body,
        scoped,
    });
}

async function isSharedFolderBody(request: NextRequest): Promise<boolean> {
    try {
        const peek = (await request.clone().json()) as { scope?: unknown } | null;
        return peek?.scope === 'organization';
    } catch {
        // No body or not JSON — the API validates it; route it as personal.
        return false;
    }
}
