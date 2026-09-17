import type { WorkspaceBackupPayload } from './workspace-backup.types';

/**
 * Workspace backup (AW-22) — producer-side interface implemented by the
 * configured job-runtime provider (Constitution IV).
 *
 * `WorkspaceBackupService.create` calls `dispatchWorkspaceBackup(...)` right
 * after it inserts the `queued` row. The archive itself can run for the best
 * part of an hour and can be gigabytes, so it can never happen inside the
 * request that asked for it (spec FR-2).
 *
 * **A `null` return is not silent here.** Every other dispatcher in this
 * package treats `null` as "deferred, something will pick it up later". A
 * backup has nothing to pick it up: there is no reconciliation pass, and a
 * row left at `queued` would show the owner a progress bar that never moves
 * until the sweeper eventually calls it stalled fifteen minutes later. So
 * the service marks the row `failed` / `internal` immediately and the card
 * explains that backups are not available in this deployment (spec FR-46).
 *
 * Mirrors {@link KbEmbedDocumentDispatcher} — same shape, so the binding
 * factory in `job-runtime.providers.ts` wires it with no special case.
 */
export interface WorkspaceBackupDispatcher {
    dispatchWorkspaceBackup(payload: WorkspaceBackupPayload): Promise<string | null>;
}

export const WORKSPACE_BACKUP_DISPATCHER = Symbol('WORKSPACE_BACKUP_DISPATCHER');
