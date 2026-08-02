import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { SubAgentDelegationRequest, SubAgentDelegationResult } from '@ever-works/contracts';
import type { SubAgentDelegationRunner } from '@ever-works/agent/agents';
import { AgentRepository, AgentRunRepository } from '@ever-works/agent/database';
import { TasksService, TaskTransitionService } from '@ever-works/agent/tasks-domain';

/**
 * The real sub-agent delegation runner (judgment layer G9).
 *
 * `SubAgentDelegationService` validates and narrows a request but is
 * deliberately runtime-free — it cannot start anything. This is the
 * binding that turns a validated request into an actual child agent run,
 * and it lives api-side because that is where the job-runtime dispatcher
 * is bound.
 *
 * ## Why it creates a child Task
 *
 * The platform's unit of agent work IS a Task: `AgentTaskExecuteDispatchPayload`
 * requires a `taskId`, and the whole production path — the concurrency
 * gate, the queued `AgentRun` row, run denormalization, telemetry,
 * escalation, task chat — hangs off one. A task-less dispatch would have
 * to reimplement all of that and would be invisible in the UI.
 *
 * So a delegation creates a CHILD Task (`parentTaskId` linkage already
 * exists and is cycle-checked) and dispatches it through
 * `TaskTransitionService.dispatchAgentRun`, the exact path a human-
 * assigned Task takes. The child is therefore observable, cancellable
 * and rate-limited like any other run — not a side channel.
 *
 * ## Why it waits
 *
 * `SubAgentDelegationStatus` has no "dispatched" member: a delegation
 * resolves to `completed | failed | refused | escalated`. A parent that
 * delegates wants the RESULT, so this polls the child run to a terminal
 * state, bounded by the request's budget. Exceeding the bound is
 * reported as `failed` with a distinct summary rather than pretending
 * the child succeeded.
 */
/**
 * Injection token for the sleep seam.
 *
 * A real token, NOT a bare `@Optional()` on an anonymous object type:
 * that has no runtime token for Nest to match, so the parameter could
 * never be injected and would silently stay `undefined` forever — a
 * decorative seam of exactly the kind this PR exists to remove.
 */
export const DELEGATION_CLOCK = 'DELEGATION_CLOCK' as const;

export interface DelegationClock {
    sleep(ms: number): Promise<void>;
}

@Injectable()
export class SubAgentDelegationRunnerService implements SubAgentDelegationRunner {
    private readonly logger = new Logger(SubAgentDelegationRunnerService.name);

    /** Poll cadence while waiting for the child run to finish. */
    private static readonly POLL_INTERVAL_MS = 2_000;
    /** Fallback ceiling when the request carries no `maxDurationMs`. */
    private static readonly DEFAULT_TIMEOUT_MS = 10 * 60_000;

    constructor(
        private readonly agents: AgentRepository,
        private readonly runs: AgentRunRepository,
        private readonly tasks: TasksService,
        private readonly transitions: TaskTransitionService,
        @Optional() @Inject(DELEGATION_CLOCK) private readonly clock?: DelegationClock,
    ) {}

    async run(request: SubAgentDelegationRequest): Promise<SubAgentDelegationResult> {
        // The request arrives already validated and NARROWED by
        // `SubAgentDelegationService`; the scope on it is the effective
        // scope. Never re-widen it — this only reads.
        const parent = await this.agents.findById(request.parentAgentId);
        if (!parent) {
            return this.failure(request, 'parent agent no longer exists');
        }

        const childAgentId = request.childAgentId ?? parent.id;
        const child = await this.agents.findById(childAgentId);
        if (!child) {
            return this.failure(request, `child agent ${childAgentId} not found`);
        }
        // Cross-owner delegation would let a parent spend someone else's
        // budget and reach their scope. The narrowing step cannot catch
        // this because it never loads the agents.
        if (child.userId !== parent.userId) {
            return this.failure(request, 'child agent belongs to a different owner');
        }

        // Recover the parent Task from the parent RUN when the caller did
        // not name one.
        //
        // Without this the child is created as a fresh ROOT: the chain has
        // no audit linkage (a delegated Task looks unrelated to the work
        // that asked for it), and `TasksService.create`'s parent-chain
        // guard is skipped entirely because it is wholly inside an
        // `if (input.parentTaskId)`. The graph path in particular never
        // supplies `parentTaskId` — it only knows the run — so without
        // this recovery every delegated Task would be an orphan.
        const parentTaskId = await this.resolveParentTaskId(request);

        let childTask: { id: string };
        try {
            childTask = await this.tasks.create(parent.userId, {
                title: this.titleFor(request),
                description: this.describe(request),
                parentTaskId,
                workId: request.scope.workId ?? null,
                // The child is raised BY an agent, not by a person. That
                // provenance is what lets the UI (and any later audit)
                // tell a delegated unit of work apart from one a human
                // filed.
                createdByType: 'agent',
                // The PARENT agent is the author of the delegation; the
                // child is merely assigned to execute it. Recording the
                // child here would lose who actually decided this work
                // should exist.
                createdById: request.parentAgentId,
                agentId: request.childAgentId ?? null,
                // Judgment layer G9 — the recursion bound, written by the
                // platform rather than declared by a caller.
                //
                // `request.depth` is the depth of THIS delegation (already
                // raised to the server-derived value by
                // `SubAgentDelegationService`), so the child sits one
                // deeper. This stamp is what the depth resolver reads back
                // on the next hop; without it the chain has no record of
                // itself and the cap is unenforceable.
                delegationDepth: (Number.isInteger(request.depth) ? request.depth : 0) + 1,
            });
        } catch (error) {
            return this.failure(
                request,
                `could not create the child Task: ${(error as Error).message}`,
            );
        }

        const dispatch = await this.transitions.dispatchAgentRun(childTask as never, childAgentId, {
            dedupKey: `delegation:${request.delegationId}`,
            // The EFFECTIVE scope — `SubAgentDelegationService` already
            // narrowed it against the parent, and the port contract says
            // never to re-widen it.
            //
            // Passing it here is what makes "privilege can only ever
            // shrink going down the tree" true at RUNTIME. Until now this
            // runner read only `request.scope.workId` and dropped the
            // rest, so the narrowed tool list was computed and discarded:
            // an over-broad request was refused, but a child that WAS
            // admitted ran with its own agent's full tool set — and
            // `childAgentId` defaults to the parent, so by default the
            // child was the parent with every permission it holds.
            delegationScope: request.scope,
        });

        if (!dispatch.runId) {
            return this.failure(
                request,
                dispatch.error ? `dispatch refused: ${dispatch.error}` : 'dispatch produced no run',
            );
        }

        const outcome = await this.awaitTerminal(dispatch.runId, request);
        return {
            delegationId: request.delegationId,
            status: outcome.status,
            summary: outcome.summary,
            output: outcome.output,
            childRunId: dispatch.runId,
            childAgentId,
            artifacts: [{ label: 'task', ref: childTask.id }],
        };
    }

    /**
     * Poll the child run to a terminal state.
     *
     * A queued run that never starts (the gate parked it, or the runtime
     * is down) must not hang the parent forever, so the wait is bounded
     * and a timeout is reported as `failed` — NOT as success with an
     * empty output, which would let a parent build on nothing.
     */
    private async awaitTerminal(
        runId: string,
        request: SubAgentDelegationRequest,
    ): Promise<{
        status: SubAgentDelegationResult['status'];
        summary: string;
        output: unknown;
    }> {
        const budgetMs =
            request.budget?.maxDurationMs ?? SubAgentDelegationRunnerService.DEFAULT_TIMEOUT_MS;
        const deadline = Date.now() + budgetMs;

        while (Date.now() < deadline) {
            const run = await this.runs.findById(runId);
            if (!run) {
                return { status: 'failed', summary: 'child run disappeared', output: null };
            }
            if (run.status === 'completed') {
                return {
                    status: 'completed',
                    summary: run.summary ?? 'child run completed',
                    output: run.summary ?? null,
                };
            }
            if (run.status === 'failed') {
                return {
                    status: 'failed',
                    summary: run.errorMessage ?? 'child run failed',
                    output: null,
                };
            }
            if (run.status === 'cancelled') {
                return { status: 'failed', summary: 'child run was cancelled', output: null };
            }
            await this.sleep(SubAgentDelegationRunnerService.POLL_INTERVAL_MS);
        }

        return {
            status: 'failed',
            summary: `child run did not finish within ${budgetMs}ms`,
            output: null,
        };
    }

    /**
     * The Task this delegation hangs off: the one the caller named, or
     * failing that the one the parent RUN belongs to.
     *
     * Never throws and never invents a link — an unresolvable parent
     * yields `null`, which is exactly the behaviour before this recovery
     * existed.
     */
    private async resolveParentTaskId(request: SubAgentDelegationRequest): Promise<string | null> {
        if (request.parentTaskId) return request.parentTaskId;
        if (!request.parentRunId) return null;
        try {
            const run = await this.runs.findById(request.parentRunId);
            return run?.taskId ?? null;
        } catch {
            return null;
        }
    }

    private sleep(ms: number): Promise<void> {
        if (this.clock) return this.clock.sleep(ms);
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private titleFor(request: SubAgentDelegationRequest): string {
        const objective = request.objective.trim().replace(/\s+/g, ' ');
        return objective.length > 120 ? `${objective.slice(0, 117)}...` : objective;
    }

    /**
     * The child's brief. Success criteria and the result-shape hint are
     * included because the child agent reads its Task description as
     * part of its prompt — that is how the delegation's intent actually
     * reaches it.
     */
    private describe(request: SubAgentDelegationRequest): string {
        const lines = [request.objective.trim()];
        if (request.successCriteria?.length) {
            lines.push('', 'Success criteria:');
            for (const criterion of request.successCriteria) lines.push(`- ${criterion}`);
        }
        if (request.resultSchemaHint) {
            lines.push('', `Expected result shape: ${request.resultSchemaHint}`);
        }
        // `inputs` are NOT inlined: they can be large and may carry
        // caller data that does not belong in a stored description.
        return lines.join('\n');
    }

    private failure(request: SubAgentDelegationRequest, summary: string): SubAgentDelegationResult {
        this.logger.warn(`Delegation ${request.delegationId} failed: ${summary}`);
        return {
            delegationId: request.delegationId,
            status: 'failed',
            summary,
            output: null,
        };
    }
}
