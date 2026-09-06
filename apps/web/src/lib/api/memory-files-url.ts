import { withWorkspaceScopeQuery, type WorkspaceScope } from '../workspace-scope';
import type { MemoryFileRow } from './memory-files-types';

/**
 * The ONE download URL both the Files table and the preview overlay use, so
 * the `<a href download>`, the KB viewers' `<img src>` / `<iframe src>`, and
 * the text-preview `fetch` all carry the identical selector. Pure: the scope
 * comes from `useWorkspaceScope()`; `null` leaves the carrier off and the
 * route runs personal.
 */
export function memoryFileDownloadUrl(
    row: Pick<MemoryFileRow, 'id' | 'source'>,
    scope: WorkspaceScope | null,
): string {
    const base = `/api/memory/files/${encodeURIComponent(row.id)}/download?source=${row.source}`;
    return scope ? withWorkspaceScopeQuery(base, scope) : base;
}
