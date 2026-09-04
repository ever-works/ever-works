import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../proxy';

/**
 * Proxy — `PATCH /api/memory/files/move` (batch file → folder move).
 *
 * Scoped (EW-786): `MemoryFilesController.moveFiles` resolves the
 * Organization from the request scope context and hands it to
 * `MemoryFilesService.moveFiles`, whose visibility query is what decides
 * whether an org Memory original is movable at all. Unscoped, moving one
 * of those rows matched nothing and reported a no-op success.
 */
export async function PATCH(request: NextRequest) {
    return proxyMemoryFiles(request, '/memory/files/move', {
        method: 'PATCH',
        body: request.body,
        scoped: true,
    });
}
