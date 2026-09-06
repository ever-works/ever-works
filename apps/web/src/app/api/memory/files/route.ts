import { NextRequest } from 'next/server';
import { proxyMemoryFiles } from './proxy';

/**
 * Proxy — `GET /api/memory/files` (unified list).
 *
 * Scoped (EW-786): `MemoryFilesController.list` reads
 * `ScopeContextService.getOrganizationId()` and passes it to
 * `MemoryFilesService.list`, which is what pulls the active
 * Organization's Memory originals into the unified listing alongside the
 * caller's own chat uploads. Unscoped, the API answered 200 with the
 * personal subset only — the Files area looked complete and quietly was
 * not. Reach this route through `browserApiFetch` (see
 * `components/memory/MemoryFilesPanel.tsx`); without the per-tab
 * selector it is a 400.
 */
export async function GET(request: NextRequest) {
    return proxyMemoryFiles(request, '/memory/files', { method: 'GET', scoped: true });
}
