import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import {
    WORKFLOW_RUN_SWEPT_FAILURE_CODE,
    WorkflowRunRepository,
} from '../database/repositories/workflow-run.repository';

/** What one sweep tick did, for the caller to log. */
export interface WorkflowRunSweepSummary {
    /** Ids that this sweep actually transitioned to `failed`. */
    swept: string[];
    /** Rows the scan matched — may exceed `swept` when a worker won the race. */
    scanned: number;
    /** The cutoff age applied, echoed so a log line is self-describing. */
    cutoffMinutes: number;
    /** False when the kill switch is off; nothing was scanned. */
    enabled: boolean;
}

/**
 * Stuck-row sweep for `workflow_runs` (judgment layer G5).
 *
 * ## Why this exists at all
 *
 * `POST /api/workflows/:id/run` inserts the row `queued`, and the Trigger.dev
 * `workflow-run` task owns it from `markStarted` onward. That task declares
 * `retry: { maxAttempts: 1 }` — deliberately, because a graph walk is not
 * safely re-runnable — so if its machine dies before a terminal write there is
 * no redelivery. The row then reads `queued`/`running` forever, with
 * `finishedAt` and `durationMs` NULL, and there is no cancel route to clear it.
 *
 * The task's `onFailure` hook is the PRIMARY recovery path and covers every
 * failure the runtime reports. This sweep is the backstop for the failures it
 * cannot report: a hard OOM, a node eviction, a `release-trigger-prod` deploy
 * mid-walk, or `maxDuration` expiry. `agent_runs` has had exactly this pair
 * since the sweeper was added for it; `workflow_runs` shipped with neither.
 *
 * This is the repo's stated rule, from `agent-heartbeat.task.ts`: "the
 * stuck-row sweep in the dispatcher is a backstop, not a primary path."
 *
 * ## What it deliberately does NOT do
 *
 * It does not touch a row inside the walk's own time budget. The cutoff is
 * clamped above the task's `maxDuration` (60 minutes) by
 * `config.workflows.getRunStuckTimeoutMinutes`, because sweeping early is the
 * unrecoverable error: the row would read `failed`, the worker's own
 * `markCompleted` would then no-op against the terminal CAS, and the real
 * result would be gone.
 */
@Injectable()
export class WorkflowRunSweeperService {
    private readonly logger = new Logger(WorkflowRunSweeperService.name);

    constructor(private readonly runs: WorkflowRunRepository) {}

    async sweepStuckRuns(): Promise<WorkflowRunSweepSummary> {
        const cutoffMinutes = config.workflows.getRunStuckTimeoutMinutes();

        if (!config.workflows.getRunSweeperEnabled()) {
            return { swept: [], scanned: 0, cutoffMinutes, enabled: false };
        }

        const cutoff = new Date(Date.now() - cutoffMinutes * 60 * 1000);
        const limit = config.workflows.getRunSweeperMaxBatch();

        const candidates = await this.runs.findStuckNonTerminal(cutoff, limit);
        if (candidates.length === 0) {
            return { swept: [], scanned: 0, cutoffMinutes, enabled: true };
        }

        const ids = candidates.map((c) => c.id);
        const affected = await this.runs.markStuckFailed(
            ids,
            `Workflow run abandoned: no terminal write within ${cutoffMinutes} minutes. ` +
                `The worker executing the graph died without reporting a failure ` +
                `(code: ${WORKFLOW_RUN_SWEPT_FAILURE_CODE}).`,
        );

        // `affected` can be lower than `ids.length`: a worker that reached its
        // own terminal write between the scan and the CAS keeps its result.
        // Report the scan and the transition separately rather than conflating
        // them — a persistent gap between the two is itself a signal.
        this.logger.warn(
            `workflow-run sweep reaped ${affected}/${ids.length} abandoned runs ` +
                `(cutoff ${cutoffMinutes}m): ${ids.join(', ')}`,
        );

        return {
            swept: affected > 0 ? ids : [],
            scanned: ids.length,
            cutoffMinutes,
            enabled: true,
        };
    }
}
