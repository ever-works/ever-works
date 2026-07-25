import { logger, schedules } from '@trigger.dev/sdk';
import { TaskWorkspaceService } from '@ever-works/agent/tasks-domain';
import { withWorkerContext } from '../../trigger/worker/utils/worker-context.utils';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';

/**
 * Remote task-branch GC (worktree-per-Task isolation, Wave 2 M6).
 *
 * The durable leak in the cloud path is REMOTE `task/*` branches whose
 * Task went terminal (done/cancelled) or was abandoned — the ephemeral
 * sandbox checkout dies with the sandbox, but the branch lives on the
 * provider forever. This sweep deletes branches per the Work's
 * `taskBranchCleanup` policy ('manual' Works are never auto-cleaned)
 * and marks the Task `branchState='cleaned'`.
 *
 * Shipped in the same wave as branch creation, deliberately — leak
 * prevention is part of the feature, not a follow-up.
 *
 * Cron offset off the hour per the sweeper-family rationale (see
 * agent-run-sweeper). Daily is enough: a leaked branch costs nothing
 * per hour, and detection lag is bounded by the 14-day staleness
 * cutoff anyway.
 */
export const taskBranchGcTask = schedules.task({
    id: 'task-branch-gc',
    cron: '41 4 * * *',
    run: async () => {
        return withWorkerContext(
            'TaskBranchGc',
            async (appContext) => {
                const svc = appContext.get(TaskWorkspaceService);
                const staleDays = Number(process.env.TASK_BRANCH_GC_STALE_DAYS) || 14;
                const summary = await svc.sweepStaleBranches({ staleDays });
                if (summary.cleaned > 0) {
                    logger.info('task-branch-gc cleaned task branches', {
                        cleaned: summary.cleaned,
                        staleDays,
                    });
                }
                return summary;
            },
            TriggerInternalModule,
        );
    },
});
