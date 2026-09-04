import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../proxy';

/**
 * Proxy — `GET /api/memory/files/tree` (folder tree + counts).
 *
 * NOT scoped (EW-786), deliberately. `MemoryFilesController.getTree`
 * calls `MemoryFoldersService.getTree(auth.userId)` and never touches
 * `ScopeContextService`: `memory_folders` is a per-user tree, the same
 * one in every workspace. Scoping this would forward a header the
 * handler ignores and would newly 400 a request that is correct today.
 */
export async function GET(request: NextRequest) {
    return proxyMemoryFiles(request, '/memory/files/tree', { method: 'GET', scoped: false });
}
