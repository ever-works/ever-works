import { Injectable, Logger, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, type Repository } from 'typeorm';
import { isAppWorkKind } from '@ever-works/contracts';
import { TaskRepository } from '../database/repositories/task.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { RailRefusal } from '../entities/rail-refusal.entity';
import { TaskStatus, type Task } from '../entities/task.entity';
import { AgentEscalationService } from '../agents/agent-escalation.service';
import { heuristicConfidence } from '../agents/escalation-confidence';
import { TaskTransitionService } from '../tasks-domain/task-transition.service';
import type { AppWorkRunStopHandler } from '../tasks-domain/task-run-stop.port';
import { APP_WORK_RUN_STOP_RAILS, classifyAppWorkRunStop } from './app-work-run-holds';

/** The most gate verdicts of one run read to classify it (the first one decides). */
export const APP_WORK_RUN_REFUSALS_SCAN = 50;

/**
 * Review of #3050 — the window opens this long before the run's row was created. `runId` alone
 * decides which verdicts are the run's; the window only lets the `(userId, createdAt)` index
 * narrow the scan, so it errs wide (clock skew between the API and the database).
 */
export const APP_WORK_RUN_REFUSALS_WINDOW_MARGIN_MS = 60_000;

/**
 * APW-08 T46 (Resolution R-17, FR-66, FR-67; ACC-08-31) — an App Work run a safety rail refused
 * ends as `needs_input`: the Task is BLOCKED and the Inbox gets one `guardrail-refusal`
 * escalation carrying the rail and the category only (never a tool argument). A run a person
 * held (a stop or pause rail) is a `wait`: nothing here moves the Task. Classified by the pure
 * {@link classifyAppWorkRunStop} over the run's own `rail_refusals` rows, which the safety gate —
 * not the model — writes.
 *
 * Bound to `APP_WORK_RUN_STOP_HANDLER` and asked by `TaskRunDenormService.recordTerminal`, the one
 * write both run paths make when a run ends. App Work Tasks only: any other Task is read once and
 * left alone. Never throws.
 */
@Injectable()
export class AppWorkRunHoldsService implements AppWorkRunStopHandler {
    private readonly logger = new Logger(AppWorkRunHoldsService.name);

    constructor(
        private readonly tasks: TaskRepository,
        private readonly works: WorkRepository,
        // `TaskTransitionService` depends on `TaskRunDenormService`, which asks THIS service at a
        // run's end: resolved lazily from the module graph so the graph has no construction cycle.
        @Optional() private readonly moduleRef?: ModuleRef,
        @Optional() private readonly runs?: AgentRunRepository,
        @Optional()
        @InjectRepository(RailRefusal)
        private readonly refusals?: Repository<RailRefusal>,
        @Optional() private readonly escalations?: AgentEscalationService,
    ) {}

    async onRunTerminal(input: {
        taskId: string;
        runId: string;
        status: 'completed' | 'failed' | 'cancelled';
    }): Promise<void> {
        try {
            if (!this.refusals) return;
            const task = await this.tasks.findById(input.taskId);
            if (!task?.workId) return;
            const work = await this.works.findById(task.workId);
            if (!work || !isAppWorkKind(work.kind)) return;

            // The run's own verdicts. The window opens at the run's ROW creation (a re-claimed run
            // re-stamps `startedAt`, which would drop its earlier verdicts), less a margin.
            const run = this.runs ? await this.runs.findById(input.runId).catch(() => null) : null;
            const created = (run as { createdAt?: Date | null } | null)?.createdAt ?? null;
            const since = created
                ? new Date(new Date(created).getTime() - APP_WORK_RUN_REFUSALS_WINDOW_MARGIN_MS)
                : null;
            const where = {
                userId: task.userId,
                runId: input.runId,
                ...(since ? { createdAt: MoreThanOrEqual(since) } : {}),
            };
            // A stop or pause rail decides first, wherever it falls in the run (review of #3050:
            // one past the oldest 50 verdicts was missed, and the owner asked instead of waiting).
            const stops = await this.refusals.find({
                where: { ...where, railId: In([...APP_WORK_RUN_STOP_RAILS]) },
                order: { createdAt: 'ASC' },
                take: APP_WORK_RUN_REFUSALS_SCAN,
            });
            const rows = await this.refusals.find({
                where,
                order: { createdAt: 'ASC' },
                take: APP_WORK_RUN_REFUSALS_SCAN,
            });
            const stop = classifyAppWorkRunStop({
                refusals: [...stops, ...rows].map((row) => ({
                    railId: row.railId,
                    category: row.category ?? null,
                    verdict: row.verdict,
                })),
            });
            if (stop?.kind !== 'needs_input') return;

            // Review of #3050 — the escalation says "so the Task is blocked": filed only when it is.
            if (!(await this.block(task))) return;
            await this.escalate(task, work.id, work.name, input.runId, stop.railId, stop.category);
        } catch (error) {
            this.logger.warn(
                `Run ${input.runId} of Task ${input.taskId}: its safety-rail outcome could not be applied (${
                    error instanceof Error ? error.message : String(error)
                }).`,
            );
        }
    }

    /**
     * `in_progress` / `in_review` → BLOCKED; true when the Task is BLOCKED afterwards (already, by
     * this move, or by a concurrent one that won the compare-and-set). A Task elsewhere (done,
     * cancelled, back in todo) is left where it is, and false is answered.
     */
    private async block(task: Task): Promise<boolean> {
        if (task.status === TaskStatus.BLOCKED) return true;
        if (task.status !== TaskStatus.IN_PROGRESS && task.status !== TaskStatus.IN_REVIEW) {
            return false;
        }
        const transitions = this.transitions();
        if (!transitions) {
            this.logger.warn(
                `Task ${task.id}: a safety rail refused its run, but no transition service is bound; it is not blocked and nothing is escalated.`,
            );
            return false;
        }
        try {
            await transitions.transition(task, TaskStatus.BLOCKED, { actorType: 'agent' });
            return true;
        } catch (error) {
            const fresh = await this.tasks.findById(task.id).catch(() => null);
            if (fresh?.status === TaskStatus.BLOCKED) return true;
            this.logger.warn(
                `Task ${task.id}: could not be blocked after a safety rail refused its run (${
                    error instanceof Error ? error.message : String(error)
                }); it is ${fresh?.status ?? 'unreadable'}, so nothing is escalated.`,
            );
            return false;
        }
    }

    private async escalate(
        task: Task,
        workId: string,
        workName: string | null | undefined,
        runId: string,
        railId: string,
        category: string | null,
    ): Promise<void> {
        if (!this.escalations) return;
        const name = workName?.trim() || 'This app';
        const what = category ? `the ${railId} rail (${category})` : `the ${railId} rail`;
        const attempted = [
            { label: 'safety', outcome: `a ${railId} rail refused an action during the change` },
        ];
        await this.escalations.record({
            userId: task.userId,
            reasonCode: 'guardrail-refusal',
            summary: `${name}: ${what} refused an action during this change, so the Task is blocked.`,
            decisionNeeded:
                'Review the refused action in Safety, then unblock the Task so the agent continues, or close it.',
            taskId: task.id,
            workId,
            agentId: task.agentId ?? null,
            attempted,
            tenantId: task.tenantId ?? null,
            organizationId: task.organizationId ?? null,
            // One per run: a run's refusal is asked about once, however often the run is read.
            dedupKey: `app-guardrail-refusal:${runId}`,
            confidence: heuristicConfidence({ reasonCode: 'guardrail-refusal', attempted }),
            confidenceSource: 'heuristic',
        });
    }

    private transitions(): TaskTransitionService | null {
        if (!this.moduleRef) return null;
        try {
            return this.moduleRef.get(TaskTransitionService, { strict: false });
        } catch {
            return null;
        }
    }
}
