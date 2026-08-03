import {
    ConflictException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { WorkflowStatus } from '../entities/workflow.entity';
import type { WorkflowRun } from '../entities/workflow-run.entity';
import { WorkflowRepository } from '../database/repositories/workflow.repository';
import {
    WorkflowRunRepository,
    type WorkflowRunListRow,
} from '../database/repositories/workflow-run.repository';
import {
    WORKFLOW_RUN_DISPATCHER,
    type WorkflowRunDispatcher,
} from '../tasks/workflow-run-dispatcher';

/**
 * Starting and reading workflow graph runs (judgment layer G5) — the
 * REQUEST side.
 *
 * ## Why this service cannot execute anything
 *
 * It holds a dispatcher, never an executor. That is the design, not an
 * omission: `POST /api/workflows/:id/run` must return the moment the run
 * is recorded, because a graph with delegate nodes can walk for tens of
 * minutes. Making the walk unreachable from here means "the endpoint does
 * not await execution" is a property of the TYPE, not of a reviewer
 * remembering not to add an `await`. The walk lives in
 * `WorkflowRunExecutorService`, which only the Trigger.dev worker boots.
 *
 * ## Why a failed enqueue is recorded as failed, not left queued
 *
 * When Trigger.dev is not configured — the ordinary case in dev and e2e —
 * the dispatcher returns `null` rather than throwing, so the endpoint
 * still answers 202. But the run is then marked `failed` with the reason,
 * because a `queued` row that nothing will ever pick up is a lie: it
 * reads as "in progress" forever and would need a sweeper to become
 * honest. The row is the account of what happened, so it says what
 * happened.
 */
@Injectable()
export class WorkflowRunsService {
    private readonly logger = new Logger(WorkflowRunsService.name);

    constructor(
        private readonly workflows: WorkflowRepository,
        private readonly runs: WorkflowRunRepository,
        // @Optional() so an install without a job runtime still boots and
        // still answers the read routes. Appended LAST per the positional-
        // spec arity rule.
        @Optional()
        @Inject(WORKFLOW_RUN_DISPATCHER)
        private readonly dispatcher?: WorkflowRunDispatcher,
    ) {}

    /**
     * Record a run and enqueue it. Returns as soon as the row exists and
     * the job is handed off — never waits for the graph.
     */
    async start(userId: string, workflowId: string): Promise<WorkflowRun> {
        const workflow = await this.workflows.findByIdAndUser(workflowId, userId);
        if (!workflow) {
            // 404, never 403 — same posture as the rest of the collection,
            // so the route cannot be used to probe which ids exist.
            throw new NotFoundException({ status: 'error', message: 'Workflow not found' });
        }
        if (workflow.status === WorkflowStatus.ARCHIVED) {
            // Archived means retired. The row stays readable and can be
            // re-activated, but starting new work against something a user
            // deliberately shelved would make "archived" mean nothing.
            throw new ConflictException({
                status: 'error',
                message: 'Workflow is archived; re-activate it before running',
            });
        }

        // DOCUMENTED dispatch-gate bypass.
        //
        // `dispatch-paths-gated.spec.ts` guards that every `createQueued(`
        // sits behind `RunDispatchGateService`, because the AgentRun
        // concurrency valve was once consulted on one path and decorative
        // on four. This call is a different thing wearing the same method
        // name: it creates a `workflow_runs` row, not an `agent_runs` one,
        // so there is no agent-run admission to make here and no
        // concurrency slot to take.
        //
        // The expensive parts of a graph ARE gated, where they are
        // actually created: an `agent.delegate` node goes through
        // `SubAgentDelegationService` into the api-side delegation runner,
        // which dispatches its child through `TaskTransitionService` — the
        // gated path — and an `ai.ask` node spends through `AiFacadeService`
        // behind `BudgetGuardService`. Gating here as well would charge a
        // graph an agent-run slot it never uses.
        //
        // What is NOT bounded yet is how many workflow runs one user may
        // have in flight; today only the route's 30/min throttle limits
        // that. Worth its own admission rule, not a borrowed one.
        const run = await this.runs.createQueued({ workflowId, userId });

        // Advisory display counters. Best-effort BY DESIGN: the
        // authoritative account of a run is its own row, and failing the
        // request because a denormalized counter did not increment would
        // trade something that matters for something that does not.
        try {
            await this.workflows.recordRun(workflowId, new Date());
        } catch (err) {
            this.logger.warn(
                `workflow ${workflowId}: run counters not updated (${(err as Error).message})`,
            );
        }

        await this.enqueue(run, workflowId, userId);

        // Re-read so the caller sees the status the enqueue actually
        // produced rather than the pre-dispatch snapshot.
        return (await this.runs.findByIdAndUser(run.id, userId)) ?? run;
    }

    async listForWorkflow(
        userId: string,
        workflowId: string,
        options: { limit?: number; offset?: number } = {},
    ): Promise<{ items: WorkflowRunListRow[]; total: number }> {
        // Prove the workflow is the caller's BEFORE listing. Without this
        // a foreign workflowId would simply return an empty page, which
        // reads as "no runs yet" instead of "not yours".
        const workflow = await this.workflows.findByIdAndUser(workflowId, userId);
        if (!workflow) {
            throw new NotFoundException({ status: 'error', message: 'Workflow not found' });
        }
        return this.runs.listForWorkflow(workflowId, userId, options);
    }

    async getRun(userId: string, runId: string): Promise<WorkflowRun> {
        const run = await this.runs.findByIdAndUser(runId, userId);
        if (!run) {
            throw new NotFoundException({ status: 'error', message: 'Workflow run not found' });
        }
        return run;
    }

    private async enqueue(run: WorkflowRun, workflowId: string, userId: string): Promise<void> {
        if (!this.dispatcher) {
            await this.runs.markDispatchFailed(
                run.id,
                'no workflow run dispatcher is bound — the job runtime is not configured',
            );
            return;
        }

        let triggerRunId: string | null;
        try {
            triggerRunId = await this.dispatcher.dispatchWorkflowRun({
                workflowRunId: run.id,
                workflowId,
                userId,
            });
        } catch (err) {
            // A throwing dispatcher must not lose the row. Record why and
            // let the caller see a failed run instead of a 500 on a run
            // that was already persisted.
            await this.runs.markDispatchFailed(run.id, (err as Error).message);
            return;
        }

        if (!triggerRunId) {
            // Deliberately does NOT name a cause. `null` from the
            // dispatcher means "not accepted" and nothing more — an
            // unconfigured job runtime is the common case, but an auth
            // failure or an unreachable API returns the same value. The
            // adapter logs the real error; asserting a reason here would
            // put a confident wrong answer on a row an operator reads.
            await this.runs.markDispatchFailed(
                run.id,
                'the job runtime did not accept the run; see the dispatcher log for the cause',
            );
            return;
        }
        await this.runs.setTriggerRunId(run.id, triggerRunId);
    }
}
