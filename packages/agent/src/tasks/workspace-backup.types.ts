/**
 * Workspace backup (AW-22) — the payload contract between
 * `WorkspaceBackupService` and the `workspace-backup` task.
 *
 * The service emits one of these when an owner presses Create backup. The
 * task claims the row, walks the fifteen domains, writes the archive and
 * settles the record.
 *
 * **Why ids and a flag, and nothing else?** The worker is a read-from-the-
 * database job: it re-reads the row, the workspace identity and the active
 * storage backend at run time through Nest DI. Carrying any of that in the
 * payload would make queue messages large and stale — a job runtime replays
 * the ORIGINAL payload on a retry, so a workspace renamed between enqueue
 * and run would be archived under the old name and nobody would know. The
 * ids re-derive everything fresh.
 *
 * `includeFullHistory` is carried even though it is also on the row, because
 * it is the one thing that changes how long the job takes, and a worker that
 * can read it without a query can pick the right queue behaviour up front.
 */
export interface WorkspaceBackupPayload {
    /** The `workspace_backups` row to produce. */
    readonly backupId: string;
    /** The workspace owner who asked for it (spec FR-10). */
    readonly userId: string;
    readonly tenantId?: string | null;
    /** `null` is the owner's un-organized workspace (spec FR-9). */
    readonly organizationId?: string | null;
    /** Spec FR-7 — lifts the trim windows to the three-year ceiling. */
    readonly includeFullHistory: boolean;

    /**
     * Enqueue-site tenant-runtime binding capture, the same pair every other
     * dispatcher carries. When present they identify the tenant-overlay
     * job-runtime that was active at enqueue time, so the worker host can
     * resolve THAT credential snapshot even if the tenant rotates the
     * overlay mid-run. Absent means "use the instance default", which is the
     * pre-overlay path and is always safe.
     */
    readonly providerId?: string | null;
    readonly credentialVersion?: number | null;
}
