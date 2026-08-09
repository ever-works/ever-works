import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WorkflowRun, type WorkflowRunStatus } from '../../entities/workflow-run.entity';

/** Source states a run may still be moved out of. */
const NON_TERMINAL: WorkflowRunStatus[] = ['queued', 'running'];
/** Narrower source set for a dispatch rollback — see `markDispatchFailed`. */
const QUEUED_ONLY: WorkflowRunStatus[] = ['queued'];

export interface CreateWorkflowRunInput {
    workflowId: string;
    userId: string;
}

/**
 * Everything a finished walk writes back. Typed off the entity so adding
 * a column cannot drift the patch shape out of sync with the row.
 */
export type WorkflowRunTerminalPatch = Partial<
    Pick<
        WorkflowRun,
        | 'trace'
        | 'output'
        | 'outputTruncated'
        | 'failureCode'
        | 'failedNodeId'
        | 'stepCount'
        | 'errorMessage'
    >
>;

/** The projection behind `GET /api/workflows/:id/runs`. */
export type WorkflowRunListRow = Pick<
    WorkflowRun,
    | 'id'
    | 'workflowId'
    | 'status'
    | 'startedAt'
    | 'finishedAt'
    | 'durationMs'
    | 'failureCode'
    | 'stepCount'
    | 'createdAt'
>;

const LIST_COLUMNS: (keyof WorkflowRun)[] = [
    'id',
    'workflowId',
    'status',
    'startedAt',
    'finishedAt',
    'durationMs',
    'failureCode',
    'stepCount',
    'createdAt',
];

/**
 * Persistence for workflow graph runs (judgment layer G5).
 *
 * Owner-scoped like `WorkflowRepository`: every read by id takes a
 * `userId`, so a foreign run resolves to `null` and the service reports
 * 404 rather than 403 — the collection cannot be used to probe which run
 * ids exist.
 *
 * ## Every status move is a CAS
 *
 * Transitions are conditional UPDATEs that name the states they are
 * allowed to move FROM, and report success as `affected > 0`. The API
 * creates the row and a separately-deployed worker finishes it, so two
 * writers genuinely race: an unconditional `update({id}, {status})` would
 * let a dispatch-rollback overwrite a run the worker had already started,
 * or a late sweeper reopen a finished one. Same posture, and the same
 * `NON_TERMINAL` / `QUEUED_ONLY` split, as `AgentRunRepository`.
 *
 * Scope columns (`tenantId` / `organizationId`) are never written here —
 * `ScopeStampingSubscriber` stamps them from the active request scope on
 * insert, and it only fills `undefined`, so assigning them (even to
 * `null`) would suppress it.
 */
@Injectable()
export class WorkflowRunRepository {
    private readonly logger = new Logger(WorkflowRunRepository.name);

    constructor(
        @InjectRepository(WorkflowRun)
        private readonly repository: Repository<WorkflowRun>,
    ) {}

    async createQueued(input: CreateWorkflowRunInput): Promise<WorkflowRun> {
        const run = this.repository.create({
            workflowId: input.workflowId,
            userId: input.userId,
            status: 'queued',
            stepCount: 0,
            outputTruncated: false,
        });
        return this.repository.save(run);
    }

    /**
     * The ONLY read by id, and it is owner-scoped on purpose — a caller
     * that cannot name the owner has no business reading the row, and the
     * absence of a bare `findById` is what stops one being written by
     * accident.
     */
    async findByIdAndUser(id: string, userId: string): Promise<WorkflowRun | null> {
        return this.repository.findOne({ where: { id, userId } });
    }

    /**
     * Run history for one workflow, newest first. Returns a PROJECTION,
     * not the entity: a list view has no use for `trace` or `output`, and
     * those are the two columns that can be kilobytes each — selecting
     * them would make the list cost scale with how much the graphs
     * produced rather than with how many runs there are.
     */
    async listForWorkflow(
        workflowId: string,
        userId: string,
        options: { limit?: number; offset?: number } = {},
    ): Promise<{ items: WorkflowRunListRow[]; total: number }> {
        const [items, total] = await this.repository.findAndCount({
            where: { workflowId, userId },
            select: LIST_COLUMNS,
            order: { createdAt: 'DESC' },
            take: options.limit ?? 50,
            skip: options.offset ?? 0,
        });
        return { items, total };
    }

    /**
     * `queued | running → running`.
     *
     * `running` is an allowed source so a Trigger.dev retry of the same
     * run re-resolves an already-started row instead of failing to claim
     * it. `triggerRunId` is only written when supplied, so a caller
     * without one cannot erase an enqueue-time stamp.
     */
    async markStarted(runId: string, triggerRunId?: string | null): Promise<boolean> {
        const patch: Partial<WorkflowRun> = { status: 'running', startedAt: new Date() };
        if (triggerRunId) patch.triggerRunId = triggerRunId;

        const result = await this.repository
            .createQueryBuilder()
            .update(WorkflowRun)
            .set(patch)
            .where('id = :runId', { runId })
            .andWhere('status IN (:...statuses)', { statuses: NON_TERMINAL })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /** Stamp the Trigger.dev run id without disturbing status. */
    async setTriggerRunId(runId: string, triggerRunId: string): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkflowRun)
            .set({ triggerRunId })
            .where('id = :runId', { runId })
            .andWhere('"triggerRunId" IS NULL')
            .execute();
        return (result.affected ?? 0) > 0;
    }

    async markCompleted(runId: string, patch: WorkflowRunTerminalPatch = {}): Promise<boolean> {
        return this.casTerminal(runId, NON_TERMINAL, { ...patch, status: 'completed' });
    }

    async markFailed(
        runId: string,
        errorMessage: string | null,
        patch: WorkflowRunTerminalPatch = {},
    ): Promise<boolean> {
        return this.casTerminal(runId, NON_TERMINAL, {
            ...patch,
            status: 'failed',
            errorMessage: errorMessage ?? patch.errorMessage ?? null,
        });
    }

    /**
     * `queued → failed`, and deliberately NOT from `running`.
     *
     * Used when the enqueue call itself failed. If the dispatcher threw
     * AFTER Trigger.dev had already accepted the job, the worker owns the
     * row from `markStarted` onward and this rollback must no-op rather
     * than kill a live run. Mirrors `AgentRunRepository.markDispatchFailed`.
     */
    async markDispatchFailed(runId: string, errorMessage: string): Promise<boolean> {
        return this.casTerminal(runId, QUEUED_ONLY, { status: 'failed', errorMessage });
    }

    async markCancelled(runId: string, userId: string): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(WorkflowRun)
            .set({ status: 'cancelled', finishedAt: new Date() })
            .where('id = :runId', { runId })
            .andWhere('"userId" = :userId', { userId })
            .andWhere('status IN (:...statuses)', { statuses: NON_TERMINAL })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * The shared terminal write: stamps `finishedAt` + `durationMs` and
     * applies the patch in ONE conditional update, so the two can never
     * disagree.
     *
     * The `startedAt` read is deliberately not atomic with the write —
     * same trade `AgentRunRepository.casTerminal` documents. A
     * `markStarted` landing in between yields `durationMs: null` for a run
     * that had executed ~0 ms anyway, and pushing the subtraction into SQL
     * would be dialect-specific (prod Postgres, CI/e2e better-sqlite3).
     * Nothing branches on `durationMs`; it is a reporting field.
     */
    private async casTerminal(
        runId: string,
        allowedFrom: WorkflowRunStatus[],
        patch: Partial<WorkflowRun>,
    ): Promise<boolean> {
        const now = new Date();
        const existing = await this.repository.findOne({
            where: { id: runId },
            select: ['id', 'startedAt'],
        });
        const durationMs = existing?.startedAt
            ? now.getTime() - new Date(existing.startedAt).getTime()
            : null;

        const result = await this.repository
            .createQueryBuilder()
            .update(WorkflowRun)
            .set({ ...patch, finishedAt: now, durationMs })
            .where('id = :runId', { runId })
            .andWhere('status IN (:...statuses)', { statuses: allowedFrom })
            .execute();

        const ok = (result.affected ?? 0) > 0;
        if (!ok) await this.warnTerminalNoOp(runId, String(patch.status));
        return ok;
    }

    /**
     * A refused transition is logged with the status that actually won,
     * so an operator can tell "the row vanished" from "a worker beat us
     * to it" — the two have completely different causes.
     */
    private async warnTerminalNoOp(runId: string, intent: string): Promise<void> {
        const current = await this.repository.findOne({
            where: { id: runId },
            select: ['id', 'status'],
        });
        this.logger.warn(
            current
                ? `workflow run ${runId}: refused to mark ${intent} — status is already '${current.status}'`
                : `workflow run ${runId}: refused to mark ${intent} — no such row`,
        );
    }
}
