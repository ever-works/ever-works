import { Injectable, Logger, Optional } from '@nestjs/common';
import { TaskRepository } from '../database/repositories/task.repository';
import { DomainEventPublisher } from '../domain-events/domain-event-publisher.service';

/**
 * Statuses `TaskRunDenormService` mirrors onto the Task row. Matches the
 * `AgentRunStatus` lifecycle for task-kind runs; `cancelled` is included
 * so a user cancel is reflected on the board too.
 */
export type TaskRunTerminalStatus = 'completed' | 'failed' | 'cancelled';

/**
 * Kanban run cockpit (Wave 2 M1) — latest-run denorm on the Task row.
 *
 * Keeps `tasks.latestRunId` / `tasks.latestRunStatus` in sync with the
 * task-kind AgentRun lifecycle so the board list can batch-embed the
 * latest run per card (one IN query on `latestRunId`) instead of a
 * per-task latest-run subquery:
 *
 * - `recordQueued`   — dispatch fan-out pre-created a queued row
 *   (`TaskTransitionService.fanOutAgentExecutions`) or the worker
 *   created one on the fly. Unconditional: the newest dispatch always
 *   takes the pointer.
 * - `recordStarted`  — worker claimed the run (`markStarted` in
 *   `agent-task-execute`). Guarded on the run id so a stale claim from
 *   an older retry can't steal the pointer from a newer queued run.
 * - `recordTerminal` — `markCompleted` / `markFailed` /
 *   `markDispatchFailed` / user cancel. Same guard.
 *
 * Every write is best-effort by contract: the denorm is board telemetry,
 * never source of truth (`agent_runs` is), so a failure here logs WARN
 * and returns false — it must never fail the run or the transition that
 * triggered it.
 */
@Injectable()
export class TaskRunDenormService {
    private readonly logger = new Logger(TaskRunDenormService.name);

    constructor(
        private readonly tasks: TaskRepository,
        // Domain events (EW-P1-1 B2) — a run-status change is a runtime-only
        // write: it records `task.runtime_updated` and bumps neither the task's
        // version nor its updatedAt. Optional (positional-spec arity rule).
        @Optional() private readonly domainEvents?: DomainEventPublisher,
    ) {}

    /** New run dispatched for the Task — unconditional pointer install. */
    async recordQueued(taskId: string, runId: string): Promise<boolean> {
        return this.write(taskId, runId, 'queued');
    }

    /** Worker claimed the run — only while the pointer is ours (or unset). */
    async recordStarted(taskId: string, runId: string): Promise<boolean> {
        return this.write(taskId, runId, 'running', runId);
    }

    /** Run reached a terminal state — only while the pointer is ours (or unset). */
    async recordTerminal(
        taskId: string,
        runId: string,
        status: TaskRunTerminalStatus,
    ): Promise<boolean> {
        return this.write(taskId, runId, status, runId);
    }

    /** Best-effort `task.runtime_updated` — telemetry, never allowed to fail the run. */
    private async recordRuntime(taskId: string, status: string): Promise<void> {
        const publisher = this.domainEvents;
        if (!publisher) return;
        try {
            await publisher.transaction((manager) =>
                publisher.runtime(manager, taskId, {
                    changedFields: ['runtime'],
                    actor: { type: 'system', id: 'agent-run', label: `run ${status}` },
                }),
            );
        } catch (err) {
            this.logger.warn(`Could not record task.runtime_updated for task ${taskId}: ${err}`);
        }
    }

    private async write(
        taskId: string,
        runId: string,
        status: string,
        expectRunId?: string,
    ): Promise<boolean> {
        try {
            const applied = await this.tasks.updateLatestRun(
                taskId,
                { latestRunId: runId, latestRunStatus: status },
                expectRunId,
            );
            if (applied) {
                await this.recordRuntime(taskId, status);
            } else {
                // Not an error: either the task row is gone, or a newer run
                // already owns the pointer — both mean "nothing to mirror".
                this.logger.debug(
                    `latest-run denorm skipped for task ${taskId}: run ${runId} → ${status} (pointer already advanced or task missing).`,
                );
            }
            return applied;
        } catch (err) {
            // Best-effort by contract — the denorm is telemetry, never truth.
            this.logger.warn(
                `latest-run denorm failed for task ${taskId}: run ${runId} → ${status}: ${err}`,
            );
            return false;
        }
    }
}
