import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from '../proxy';

/**
 * Proxy — `GET /api/memory/files/tree` (folder tree + counts).
 *
 * NOT scoped (EW-786) for the personal tree, deliberately.
 * `MemoryFilesController.getTree` calls
 * `MemoryFoldersService.getTree(auth.userId)` and never touches
 * `ScopeContextService`: `memory_folders` is a per-user tree, the same
 * one in every workspace. Scoping this would forward a header the
 * handler ignores and would newly 400 a request that is correct today.
 *
 * `?scope=organization` is the Knowledge library's shared-folder tree, which
 * the handler reads for the Organization in scope — so that call alone
 * carries the per-tab selector (and fails closed without it). The query is
 * forwarded; the API's tree DTO knows `scope`.
 */
export async function GET(request: NextRequest) {
    const shared = request.nextUrl.searchParams.get('scope') === 'organization';
    return proxyMemoryFiles(request, '/memory/files/tree', { method: 'GET', scoped: shared });
}
