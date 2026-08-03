import { Injectable, Logger } from '@nestjs/common';
import { WorkflowGraphExecutorService } from '../agents/workflow-graph-executor.service';
import { summarizeWorkflowRun } from '../agents/workflow-run-trace';
import type { WorkflowRunStatus } from '../entities/workflow-run.entity';
import { WorkflowRepository } from '../database/repositories/workflow.repository';
import { WorkflowRunRepository } from '../database/repositories/workflow-run.repository';

export interface ExecuteWorkflowRunInput {
    readonly workflowRunId: string;
    readonly userId: string;
    /** Trigger.dev run id, stamped on the row when the worker claims it. */
    readonly triggerRunId?: string | null;
}

/**
 * Walking a saved graph and recording what happened (judgment layer G5) —
 * the WORKER side.
 *
 * Only the Trigger.dev `workflow-run` task boots this. Its counterpart,
 * `WorkflowRunsService`, holds a dispatcher and no executor; this one
 * holds an executor and no dispatcher. Splitting them is what makes "the
 * API never awaits a graph walk" structural rather than a convention.
 *
 * ## The terminal status is the executor's verdict, not a guess
 *
 * Whatever `WorkflowGraphExecutorService` returns decides the row. The
 * executor is documented never to throw on a graph's account — every stop
 * is a typed `WorkflowRunResult` — so there is exactly one mapping:
 *
 *   `completed` → `completed`
 *   `failed`    → `failed` (+ `failureCode`, `failedNodeId`)
 *   `blocked`   → `failed` (+ the code that says it was blocked)
 *
 * `blocked` collapses into `failed` because the row's status set is the
 * same five as `agent_runs`, and the distinction the executor draws
 * (retryable infrastructure gap vs the author's mistake) survives intact
 * in `failureCode` — `no-node-runner` and `llm-decide-unavailable` say it
 * precisely. Adding a sixth status would make every consumer learn a
 * distinction that a column already carries.
 *
 * ## Idempotency
 *
 * A Trigger.dev retry re-runs this with the same payload. A run already
 * in a terminal state is returned as-is rather than re-walked, because
 * re-walking would spend real money (`ai.ask` nodes) and, once delegation
 * is bound, spawn real child agent runs a second time.
 */
@Injectable()
export class WorkflowRunExecutorService {
    private readonly logger = new Logger(WorkflowRunExecutorService.name);

    constructor(
        private readonly workflows: WorkflowRepository,
        private readonly runs: WorkflowRunRepository,
        private readonly executor: WorkflowGraphExecutorService,
    ) {}

    async execute(input: ExecuteWorkflowRunInput): Promise<WorkflowRunStatus> {
        const run = await this.runs.findByIdAndUser(input.workflowRunId, input.userId);
        if (!run) {
            // The row is the work order. Without it there is nothing to
            // record against, so failing loudly is the only honest option —
            // a silent return would look like a successful no-op run.
            throw new Error(
                `workflow run ${input.workflowRunId} not found for user ${input.userId}`,
            );
        }
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
            this.logger.log(
                `workflow run ${run.id}: already '${run.status}' — not re-executing on retry`,
            );
            return run.status;
        }

        const workflow = await this.workflows.findByIdAndUser(run.workflowId, run.userId);
        if (!workflow) {
            // Deleting a workflow mid-run is legal (the delete route is a
            // hard delete and says so). The run record outlives it and has
            // to say why it stopped.
            await this.runs.markFailed(run.id, 'the workflow was deleted before the run started', {
                failureCode: 'workflow-deleted',
            });
            return 'failed';
        }

        const claimed = await this.runs.markStarted(run.id, input.triggerRunId ?? null);
        if (!claimed) {
            // Another worker won the claim. Report what actually happened
            // rather than executing a second walk against the same row.
            const current = await this.runs.findByIdAndUser(run.id, run.userId);
            return current?.status ?? 'failed';
        }

        const result = await this.executor.execute(workflow.graph, {
            // The PERSISTED run id, so a node's context carries an id that
            // can be looked up afterwards instead of the executor's own
            // ephemeral `wf-…` token.
            runId: run.id,
            context: {
                userId: run.userId,
                workId: workflow.workId ?? null,
                organizationId: workflow.organizationId ?? null,
            },
        });

        const summary = summarizeWorkflowRun(result);
        const patch = {
            trace: summary.trace,
            output: summary.output,
            outputTruncated: summary.outputTruncated,
            failureCode: summary.failureCode,
            failedNodeId: summary.failedNodeId,
            stepCount: summary.stepCount,
        };

        if (result.status === 'completed') {
            await this.runs.markCompleted(run.id, patch);
            return 'completed';
        }

        await this.runs.markFailed(run.id, summary.trace.errors[0] ?? null, patch);
        return 'failed';
    }
}
