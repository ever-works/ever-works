import { isAppWorkKind } from '@ever-works/contracts';

import { config } from '../config';

/**
 * APW-08 FR-12 / T12 — the ONE gate every API-side (cloud) path asks before it
 * publishes an App Work change: a push of a branch, or a pull request.
 *
 * ## The owner decision it carries (2026-09-25)
 *
 * FR-12 lets an agent run on an App Work execute only on an enrolled Fleet node
 * or in an isolated environment that holds no platform secret, and the
 * admission that enforces it (T12) has not landed. Until it does, the cloud
 * path publishes no App Work change — refused by default, and judged before the
 * push only when an operator sets `APP_WORKS_CLOUD_PUSH_ENABLED=true`.
 *
 * ## Who asks it — and who must not
 *
 * - `TaskWorkspaceService.finalizeRun`, the isolated-Task finalize. Its only
 *   caller is the cloud executor (`packages/tasks` `agent-task-execute.task.ts`,
 *   through the worker's remote proxy into the API).
 * - The `AGENT_GIT_FACADE` adapter in `apps/api/src/agents/agents.module.ts` —
 *   the `commitToRepo` and `openPullRequest` Agent tools. That token is bound in
 *   the API process only, and Agent tools run only inside the API's
 *   `AgentRunService`.
 *
 * The Fleet path never asks it, and must not. A node pushes with its own scoped
 * credential and the platform judges the branch afterwards
 * (`finalizeRemotePush`, `finalizeMountPush`, `judgeAppWorkBranch`, then the
 * merge gate): that is the supported path while this is off. The distinction is
 * WHERE the call is made, not a flag — nothing here can tell a Fleet run from a
 * cloud one — so no Fleet-path method may call it.
 *
 * ## It never reads the environment itself
 *
 * The switch has one reader, `config.everWorks.apps.cloudPushEnabled()`
 * (exactly `'true'`, read per call). Every other Work kind answers `true` BEFORE
 * that read, so their behaviour does not change in any way.
 */
export function appWorkCloudPushAllowed(kind: string | null | undefined): boolean {
    if (!isAppWorkKind(kind)) return true;
    return config.everWorks.apps.cloudPushEnabled();
}

/**
 * The refusal every cloud path gives, word for word: what the owner decided and
 * why (FR-12, T12), what did NOT happen, and the two ways forward.
 *
 * `consequence` is the caller's, because each path withholds something
 * different and must say exactly that: `finalizeRun` says nothing was pushed
 * (and whether an open pull request contains the change), `commitToRepo` that
 * nothing was written, committed or pushed, `openPullRequest` that nothing was
 * pushed and no pull request was opened.
 */
export function appWorkCloudPushRefusal(consequence: string): string {
    return [
        'Cloud runs do not publish App Work changes yet. APW-08 FR-12 lets an App Work run only on ' +
            'an enrolled Fleet node or in an isolated environment that holds no platform secret, and ' +
            `the admission that enforces it (APW-08 T12) has not landed. ${consequence}`,
        '',
        'Run this Task on an enrolled Fleet node, or ask an operator to allow cloud App Work ' +
            'pushes (`APP_WORKS_CLOUD_PUSH_ENABLED`).',
    ].join('\n');
}
