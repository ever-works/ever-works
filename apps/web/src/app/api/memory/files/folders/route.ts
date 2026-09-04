import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../proxy';

/**
 * Proxy — `POST /api/memory/files/folders` (create folder).
 *
 * NOT scoped (EW-786): `MemoryFilesController.createFolder` delegates to
 * `MemoryFoldersService.createFolder(auth.userId, …)`. Folders are
 * per-user, not per-Organization — see `tree/route.ts`.
 */
export async function POST(request: NextRequest) {
    return proxyMemoryFiles(request, '/memory/files/folders', {
        method: 'POST',
        body: request.body,
        scoped: false,
    });
}
