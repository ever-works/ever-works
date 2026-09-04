import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../proxy';

/**
 * Proxy — `POST /api/memory/files/upload` (multipart, streamed upstream).
 *
 * NOT scoped (EW-786), deliberately. `MemoryFilesController.upload`
 * validates the folder against `auth.userId`, stores through
 * `UploadsService.saveFile(auth.userId, …)` and files the row by sha256
 * — no `ScopeContextService` anywhere on the path. The bytes land in the
 * caller's own `user_uploads` spine regardless of workspace, so there is
 * no Organization for a scope header to select.
 */
export async function POST(request: NextRequest) {
    return proxyMemoryFiles(request, '/memory/files/upload', {
        method: 'POST',
        body: request.body,
        scoped: false,
    });
}
