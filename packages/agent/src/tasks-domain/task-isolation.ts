/** Per-Task isolation override values accepted end-to-end (API DTO ↔ domain ↔ entity). */
export type TaskIsolationMode = 'on' | 'off';

/**
 * Task-isolation resolution + branch identity (Wave 2 M1).
 *
 * ONE function decides whether a Task executes in an isolated
 * workspace, so every caller (worker pre-run, UI chip, PR flow)
 * agrees. Clamps:
 *   - a Task with no `workId` has nothing to branch → off;
 *   - an Agent without repo-commit permission → off (the isolation
 *     flow's whole output is a branch + PR).
 */
export interface TaskIsolationTaskView {
    workId?: string | null;
    isolationMode?: string | null;
}

export interface TaskIsolationWorkView {
    taskIsolation?: string | null;
}

export function resolveTaskIsolation(
    task: TaskIsolationTaskView,
    work: TaskIsolationWorkView | null | undefined,
    opts: { agentCanCommit?: boolean } = {},
): 'on' | 'off' {
    if (!task.workId) return 'off';
    if (opts.agentCanCommit === false) return 'off';
    if (task.isolationMode === 'on') return 'on';
    if (task.isolationMode === 'off') return 'off';
    return work?.taskIsolation === 'worktree' ? 'on' : 'off';
}

/**
 * Deterministic, collision-free branch name. Task slugs are per-USER
 * unique only (two users on one Work can both own `T-42`), so the id
 * suffix carries global uniqueness while the slug carries readability.
 * Re-runs recompute the SAME name — the branch is the durable
 * workspace identity in cloud mode. The stored `task.branchRef` is
 * authoritative once written; this function is only for first cut.
 */
export function taskBranchName(task: { id: string; slug?: string | null }): string {
    const slug = (task.slug ?? 'task')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
    // FULL normalized id — an 8-char prefix is only 32 bits, and a
    // remote-branch collision would silently share a branch between two
    // Tasks (the binding stamp only heals the LOCAL dir).
    const idBlock = task.id.replace(/-/g, '');
    return `task/${slug || 'task'}-${idBlock}`;
}
