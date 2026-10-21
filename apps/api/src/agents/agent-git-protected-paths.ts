/**
 * Prompt-injection hardening — the Agent git tools' view of the repository
 * paths an Agent may never change. The rules live in ONE place, the agent
 * package's `policy/agent-protected-repo-paths.ts`, shared with the cloud
 * workspace finalize and the fleet pull-request path; this file re-exports
 * them and adds the tools' throwing form.
 */
import {
    alwaysProtectedRepoPaths,
    protectedRepoPathsRefusal,
    workflowChangesAllowedForWork,
} from '@ever-works/agent/policy';

export {
    ALWAYS_PROTECTED_REPO_PREFIXES,
    AGENT_WORKFLOW_CHANGES_ALLOWED_WORKS_ENV,
    alwaysProtectedRepoPaths,
    isAlwaysProtectedRepoPath,
    workflowChangesAllowedForWork,
} from '@ever-works/agent/policy';

/**
 * Throw when any of `paths` is always protected — unless the operator lifted
 * the floor for `workId` (`AGENT_WORKFLOW_CHANGES_ALLOWED_WORKS`). The message
 * names the paths (never their content) and what was NOT done, matching the
 * other refusals of the Agent git tools.
 */
export function assertNoAlwaysProtectedPaths(
    toolName: string,
    paths: ReadonlyArray<string | null | undefined>,
    nothingDone: string,
    workId?: string | null,
): void {
    if (workflowChangesAllowedForWork(workId)) return;
    const hits = alwaysProtectedRepoPaths(paths);
    if (hits.length === 0) return;
    throw new Error(`${toolName}: ${protectedRepoPathsRefusal(hits)} ${nothingDone}`);
}
