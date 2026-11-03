import { PLATFORM_DEFAULT_MERGE_POLICY, isAppWorkKind } from '@ever-works/contracts';

/** Per-Task isolation override values accepted end-to-end (API DTO ↔ domain ↔ entity). */
export type TaskIsolationMode = 'on' | 'off';

/**
 * APW-08 T11 (FR-9, ACC-08-07) — the copy an App Work Task gets when the Agent asked to run it
 * may not commit. It is plan §5.2's `appRules.noCommitPermission`, verbatim: an App Work's
 * changes always go through a branch, and a branch is only ever cut for an Agent that may commit
 * to it. Declared here, in the leaf that decides isolation, so the dispatch refusal
 * (`TaskTransitionService.dispatchAgentRun`) and any surface that explains it share one string.
 */
export const APP_WORK_NO_COMMIT_PERMISSION_MESSAGE =
    "This agent can't commit, and changes to an app always go through a branch.";

/** The stable code that prefixes the FR-9 refusal on a dispatch result, so a reader can match it. */
export const APP_WORK_NO_COMMIT_PERMISSION_CODE = 'no_commit_permission';

/** The dispatch `error` for an FR-9 refusal: the code, then the member-facing copy. */
export function describeAppWorkNoCommitPermission(): string {
    return `${APP_WORK_NO_COMMIT_PERMISSION_CODE}: ${APP_WORK_NO_COMMIT_PERMISSION_MESSAGE}`;
}

/**
 * Task-isolation resolution + branch identity (Wave 2 M1).
 *
 * ONE function decides whether a Task executes in an isolated
 * workspace, so every caller (worker pre-run, UI chip, PR flow)
 * agrees. Clamps:
 *   - a Task with no `workId` has nothing to branch → off;
 *   - an Agent without repo-commit permission → off (the isolation
 *     flow's whole output is a branch + PR);
 *   - APW-08 T11 (FR-9) — a Task on an App Work → ON, whatever the
 *     Work's setting or the Task's own override says (below).
 */
export interface TaskIsolationTaskView {
    workId?: string | null;
    isolationMode?: string | null;
}

export interface TaskIsolationWorkView {
    taskIsolation?: string | null;
    /**
     * APW-08 T11 — the Work's kind, read only to force an App Work on. Optional so every
     * existing caller and structural double (`{ taskIsolation }`) keeps compiling and keeps
     * resolving exactly as before: a view without a kind is never an App Work.
     */
    kind?: string | null;
}

export function resolveTaskIsolation(
    task: TaskIsolationTaskView,
    work: TaskIsolationWorkView | null | undefined,
    opts: { agentCanCommit?: boolean } = {},
): 'on' | 'off' {
    if (!task.workId) return 'off';
    // Unchanged by APW-08 T11 on purpose: an Agent that may not commit gets no workspace
    // here, on every kind. On an App Work such a run never gets this far — the dispatch path
    // refuses it with the FR-9 copy (`describeAppWorkNoCommitPermission`) — so this clamp only
    // decides what a run already in flight does if the Agent lost the permission since.
    if (opts.agentCanCommit === false) return 'off';
    // APW-08 T11 (FR-9, ACC-08-07) — every agent-executed Task on an App Work is isolated on
    // its own branch, and a Task cannot opt out: an App Work's code is the member's own
    // repository, and a change reaches it only as a reviewed pull request (plan §2.6). Read
    // BEFORE the per-Task override and the Work setting, so neither can turn it off. Every
    // other kind falls through to exactly the rules it had before.
    if (isAppWorkKind(work?.kind)) return 'on';
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

/**
 * Prompt-injection hardening — the branches a Task's isolated branch may NEVER
 * be: the platform's protected release/integration branches
 * (`PLATFORM_DEFAULT_MERGE_POLICY.protectedBranches`: main, master, develop,
 * stage) plus the Work's own base branch. A Task branch is where an agent
 * commits and from where the platform pushes; naming a protected branch there
 * (a template's `branchName: develop`, a stored `branchRef`) would turn the
 * agent's ordinary push into a push straight onto that branch.
 *
 * Compared the way the merge path compares branches: `refs/heads/` stripped,
 * case-insensitive.
 */
export function protectedTaskBranchReason(
    branch: string | null | undefined,
    baseRef?: string | null,
    /** Branches the Work's EFFECTIVE merge policy protects on top of the platform's. */
    policyProtectedBranches: readonly string[] = [],
): string | null {
    if (typeof branch !== 'string' || !branch.trim()) return null;
    const normalize = (ref: string): string =>
        ref
            .trim()
            .replace(/^refs\/heads\//i, '')
            .toLowerCase();
    const candidate = normalize(branch);
    const protectedBranches = new Set(
        [...PLATFORM_DEFAULT_MERGE_POLICY.protectedBranches, ...policyProtectedBranches]
            .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
            .map((name) => normalize(name)),
    );
    if (protectedBranches.has(candidate)) {
        return `'${branch.trim()}' is a protected branch`;
    }
    if (baseRef && normalize(baseRef) === candidate) {
        return `'${branch.trim()}' is this Work's base branch`;
    }
    return null;
}
