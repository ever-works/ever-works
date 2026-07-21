import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { AgentRun, AgentRunStatus, AgentRunTriggerKind } from '../../entities/agent-run.entity';

/**
 * Statuses a run may be transitioned OUT OF by a normal terminal write.
 * Anything already terminal (`completed` / `failed` / `cancelled`) is left
 * alone — see {@link AgentRunRepository.casTerminal}.
 */
const NON_TERMINAL: AgentRunStatus[] = ['queued', 'running'];

/**
 * Dispatch rollback may only touch a run that has NOT been picked up yet.
 * `running` is deliberately excluded: if `enqueue()` threw on a timeout but
 * Trigger.dev had in fact accepted the job, the worker is already executing
 * and marking it failed would stomp a live run.
 */
const QUEUED_ONLY: AgentRunStatus[] = ['queued'];

@Injectable()
export class AgentRunRepository {
    private readonly logger = new Logger(AgentRunRepository.name);

    constructor(
        @InjectRepository(AgentRun)
        private readonly repository: Repository<AgentRun>,
    ) {}

    async findById(id: string): Promise<AgentRun | null> {
        return this.repository.findOne({ where: { id } });
    }

    /**
     * @internal Background workers and internal services that have already
     * verified agent ownership through another path (e.g. agent-run.service
     * receives an `Agent` entity from an ownership-checked query) may use
     * this method. HTTP handlers MUST use {@link findByAgentAndUser} instead
     * to prevent latent IDOR if ownership gating is ever omitted upstream.
     *
     * Security: unscoped — caller is responsible for ensuring agentId
     * belongs to the acting user before calling this method.
     */
    async findByAgent(agentId: string, limit = 25, offset = 0): Promise<AgentRun[]> {
        return this.repository.find({
            where: { agentId },
            order: { createdAt: 'DESC' },
            take: limit,
            skip: offset,
        });
    }

    /**
     * @internal Background workers and internal services that have already
     * verified agent ownership through another path may use this method.
     * HTTP handlers MUST use {@link countByAgentAndUser} instead.
     *
     * Security: unscoped — caller is responsible for ensuring agentId
     * belongs to the acting user before calling this method.
     */
    async countByAgent(agentId: string): Promise<number> {
        return this.repository.count({ where: { agentId } });
    }

    // Security: user-scoped variants — use these in HTTP handlers instead of
    // findByAgent/countByAgent to enforce ownership at the repository layer
    // and prevent latent IDOR if a future caller omits the service-level guard.
    async findByAgentAndUser(
        agentId: string,
        userId: string,
        limit = 25,
        offset = 0,
    ): Promise<AgentRun[]> {
        return this.repository.find({
            where: { agentId, userId },
            order: { createdAt: 'DESC' },
            take: limit,
            skip: offset,
        });
    }

    async countByAgentAndUser(agentId: string, userId: string): Promise<number> {
        return this.repository.count({ where: { agentId, userId } });
    }

    /**
     * FU-2 — cancel a queued / running AgentRun. The (id, userId) guard
     * ensures cross-user runs return null (controller maps that to 404
     * per architecture/security §9, no-existence-leak).
     */
    async findByIdAndUser(runId: string, userId: string): Promise<AgentRun | null> {
        return this.repository.findOne({ where: { id: runId, userId } });
    }

    /**
     * FU-2 (post-review) — atomic cancel. Greptile P1 caught a race
     * between the original `findOne` + unconditional `update`: a
     * background worker could flip the run to `completed` or `failed`
     * between the two SQL round-trips, and our follow-up `update`
     * would overwrite that terminal status with `cancelled` and reset
     * `finishedAt`, corrupting the run record.
     *
     * Fix: combine the existence + ownership check + status guard
     * into one conditional UPDATE statement. The CAS-style WHERE
     * clause only flips queued/running → cancelled when nothing else
     * has touched the row first. We still need a separate findOne to
     * distinguish "not found" from "already terminal" for the
     * controller's HTTP shape, but the *cancel* itself is now atomic.
     */
    async cancel(
        runId: string,
        userId: string,
    ): Promise<{
        found: boolean;
        previousStatus?: AgentRunStatus;
        /**
         * Trigger.dev run id of the cancelled row, so the caller can also
         * cancel the remote run. Null when the run was never stamped —
         * dispatch failed, or the enqueue-time stamp lost the race and the
         * worker had not yet reached `markStarted`.
         */
        triggerRunId?: string | null;
    }> {
        const run = await this.repository.findOne({
            where: { id: runId, userId },
            select: ['id', 'status', 'triggerRunId'],
        });
        if (!run) return { found: false };
        if (run.status !== 'queued' && run.status !== 'running') {
            return { found: true, previousStatus: run.status, triggerRunId: run.triggerRunId };
        }
        const result = await this.repository
            .createQueryBuilder()
            .update(AgentRun)
            .set({ status: 'cancelled', finishedAt: new Date() })
            .where('id = :id', { id: runId })
            .andWhere('userId = :userId', { userId })
            .andWhere('status IN (:...statuses)', {
                statuses: ['queued', 'running'] satisfies AgentRunStatus[],
            })
            .execute();
        // affected=0 ⇒ a concurrent worker flipped the row terminal
        // between our findOne and this CAS — surface that as a
        // graceful no-op so the controller responds 200/no-cancel
        // instead of 5xx.
        if ((result.affected ?? 0) === 0) {
            const fresh = await this.repository.findOne({
                where: { id: runId },
                select: ['id', 'status', 'triggerRunId'],
            });
            return {
                found: true,
                previousStatus: fresh?.status ?? run.status,
                // Re-read: the worker may have stamped `triggerRunId` via
                // markStarted between our first read and this CAS.
                triggerRunId: fresh?.triggerRunId ?? run.triggerRunId,
            };
        }
        return { found: true, previousStatus: run.status, triggerRunId: run.triggerRunId };
    }

    /**
     * Rows abandoned by a worker that died without reaching any checkpoint —
     * OOM, node eviction, deploy, Trigger.dev teardown. Nothing else reaps
     * them: `recoverStuckRunning()` operates exclusively on `agents` rows.
     *
     * Left alone they stay `queued`/`running` forever, and
     * {@link findInFlightForTaskAgent} keeps treating them as in-flight — which
     * permanently suppresses dispatch for that task-agent pair. That is the
     * same user-visible bug as an orphaned queued run, reached by a different
     * route.
     *
     * `COALESCE(startedAt, createdAt)` covers both statuses in one predicate:
     * `startedAt` is NULL while queued, and {@link markStarted} is provably the
     * only writer of `status='running'` and sets both in one atomic UPDATE, so
     * `running` implies `startedAt IS NOT NULL` with no torn window. The
     * COALESCE is also defence against a future second writer.
     *
     * Bounded by `limit` on purpose — see {@link markStuckFailed}.
     */
    async findStuckNonTerminal(
        cutoff: Date,
        limit: number,
    ): Promise<
        Pick<AgentRun, 'id' | 'agentId' | 'triggerKind' | 'status' | 'startedAt' | 'createdAt'>[]
    > {
        return this.repository
            .createQueryBuilder('run')
            .select([
                'run.id',
                'run.agentId',
                'run.triggerKind',
                'run.status',
                'run.startedAt',
                'run.createdAt',
            ])
            .where('run.status IN (:...statuses)', { statuses: NON_TERMINAL })
            .andWhere('COALESCE(run.startedAt, run.createdAt) <= :cutoff', { cutoff })
            .orderBy('COALESCE(run.startedAt, run.createdAt)', 'ASC')
            .limit(limit)
            .getMany();
    }

    /**
     * Bulk-reap the ids returned by {@link findStuckNonTerminal}.
     *
     * One statement, CAS-guarded on `queued|running`, so a worker that finished
     * in the gap between the select and this update keeps its result — the row
     * simply is not counted. Returns `affected`, NOT `runIds.length`: reporting
     * the input size would overstate the sweep every time that race is lost.
     *
     * `durationMs` is deliberately left NULL. It cannot be computed in a bulk
     * statement, and NULL is the honest value for "we do not know when this
     * died" — nothing branches on it.
     */
    async markStuckFailed(runIds: string[], errorMessage: string): Promise<number> {
        // TypeORM renders `IN (:...ids)` as invalid SQL for an empty array.
        if (runIds.length === 0) return 0;
        const result = await this.repository
            .createQueryBuilder()
            .update(AgentRun)
            .set({ status: 'failed', finishedAt: new Date(), errorMessage })
            .where('id IN (:...runIds)', { runIds })
            .andWhere('status IN (:...statuses)', { statuses: NON_TERMINAL })
            .execute();
        return result.affected ?? 0;
    }

    async createQueued(args: {
        agentId: string;
        userId: string;
        triggerKind: AgentRunTriggerKind;
        taskId?: string | null;
        chatMessageId?: string | null;
    }): Promise<AgentRun> {
        const run = this.repository.create({
            agentId: args.agentId,
            userId: args.userId,
            triggerKind: args.triggerKind,
            status: 'queued',
            taskId: args.taskId ?? null,
            chatMessageId: args.chatMessageId ?? null,
        });
        return this.repository.save(run);
    }

    /**
     * Stamp the Trigger.dev run id onto a row that has just been enqueued,
     * so a cancel arriving before the worker starts still has something to
     * cancel remotely. Without this the column stayed NULL for a run's whole
     * lifetime and cancelling could only ever update our own DB.
     *
     * No-clobber by construction (`triggerRunId IS NULL`): the worker can
     * reach `markStarted` before this stamp commits, and both write the same
     * value, so whichever lands second must not overwrite. Best-effort —
     * callers swallow failures, since losing the stamp costs a remote cancel,
     * not correctness.
     */
    async setTriggerRunId(runId: string, triggerRunId: string): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .update(AgentRun)
            .set({ triggerRunId })
            .where('id = :id', { id: runId })
            .andWhere('triggerRunId IS NULL')
            .execute();
    }

    /**
     * Claim a run for execution. CAS-guarded so a cancel that lands between
     * the worker's status check and this write is not silently reverted
     * `cancelled -> running`.
     *
     * That mattered little while cancel was DB-only, but now that cancelling
     * actually kills the Trigger.dev run, losing this race would strand the
     * row in `running` with no worker alive to finalize it. {@link findStuckNonTerminal}
     * + {@link markStuckFailed} now reap such rows, but only after hours — the
     * CAS is what keeps the row correct in the meantime. Returns whether the
     * claim succeeded so the worker can bail instead of executing a run that
     * was cancelled or swept.
     *
     * Allows `queued|running` (NOT queued-only): heartbeat re-resolves an
     * already-`running` row via `findInFlightForAgent` on retry, and a
     * queued-only guard would no-op every legitimate retry.
     *
     * `triggerRunId` is only written when non-null, so a worker passing null
     * cannot erase a value stamped at enqueue time by {@link setTriggerRunId}.
     */
    async markStarted(runId: string, triggerRunId: string | null): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(AgentRun)
            .set({
                status: 'running',
                startedAt: new Date(),
                ...(triggerRunId ? { triggerRunId } : {}),
            })
            .where('id = :id', { id: runId })
            .andWhere('status IN (:...statuses)', { statuses: NON_TERMINAL })
            .execute();
        const ok = (result.affected ?? 0) > 0;
        if (!ok) await this.warnTerminalNoOp(runId, 'markStarted');
        return ok;
    }

    /**
     * FU-3 — atomic terminal transition, shared by {@link markCompleted},
     * {@link markFailed} and {@link markDispatchFailed}.
     *
     * These were previously a `findOne` (for `durationMs`) followed by an
     * unconditional `update(runId, …)` keyed on the primary key alone, so any
     * of them could overwrite a status a concurrent writer had already
     * committed:
     *
     *  - a dispatch-failure rollback whose `enqueue()` timed out *after*
     *    Trigger.dev accepted the job would stomp the now-`running` run;
     *  - `AgentRunService.finalize()` would erase a user's `cancelled` with
     *    `failed` or `completed`, because cancelling does not stop the worker.
     *
     * Same CAS-style WHERE clause {@link cancel} already uses. Returns whether
     * the row was actually transitioned so callers can report a no-op. The
     * `agent_runs` sweeper ({@link markStuckFailed}) only reaps rows that are
     * hours old, so within a normal run a silent miss here is still effectively
     * unrecoverable and invisible — keep reporting it.
     *
     * The `durationMs` read stays non-atomic on purpose (applies equally to
     * `markFailed` and `markCompleted`). `startedAt` is read before the CAS
     * write, so a `markStarted` landing in that gap is read as `null` and
     * `durationMs` is stored as `null` for a run that technically did start.
     * That is acceptable: to hit the window `markStarted` must land between the
     * two round-trips, which means the run had been executing for ~0 ms anyway,
     * so `null` and `0` carry the same information. Closing it properly needs
     * the subtraction pushed into SQL (`RETURNING`, or `finishedAt - startedAt`
     * as an expression), which is dialect-specific — the e2e suite runs on
     * sqlite while production is Postgres — so it would trade a cosmetic
     * reporting gap for a real portability hazard. `durationMs` is a reporting
     * field only; nothing branches on it.
     */
    private async casTerminal(
        runId: string,
        allowedFrom: AgentRunStatus[],
        patch: QueryDeepPartialEntity<AgentRun>,
    ): Promise<boolean> {
        const now = new Date();
        const run = await this.repository.findOne({
            where: { id: runId },
            select: ['id', 'startedAt'],
        });
        const durationMs = run?.startedAt ? now.getTime() - run.startedAt.getTime() : null;
        const result = await this.repository
            .createQueryBuilder()
            .update(AgentRun)
            .set({ ...patch, finishedAt: now, durationMs })
            .where('id = :id', { id: runId })
            .andWhere('status IN (:...statuses)', { statuses: allowedFrom })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Log a CAS no-op with the status that actually won, so an operator can
     * tell "row vanished" from "a worker beat us to it".
     */
    private async warnTerminalNoOp(runId: string, intent: string): Promise<void> {
        const fresh = await this.repository
            .findOne({ where: { id: runId }, select: ['id', 'status'] })
            .catch(() => null);
        this.logger.warn(
            `AgentRun ${runId}: ${intent} skipped — row is ${fresh ? `already '${fresh.status}'` : 'missing'}.`,
        );
    }

    async markCompleted(runId: string, summary: string | null): Promise<void> {
        const ok = await this.casTerminal(runId, NON_TERMINAL, { status: 'completed', summary });
        if (!ok) await this.warnTerminalNoOp(runId, 'markCompleted');
    }

    async markFailed(runId: string, errorMessage: string): Promise<void> {
        const ok = await this.casTerminal(runId, NON_TERMINAL, { status: 'failed', errorMessage });
        if (!ok) await this.warnTerminalNoOp(runId, 'markFailed');
    }

    /**
     * Roll a pre-created run back to `failed` after the external enqueue threw.
     *
     * Narrower than {@link markFailed} by design — only a still-`queued` run may
     * be rolled back. Callers create the row, then enqueue; if the enqueue call
     * fails but the job was nevertheless accepted, the worker owns the row from
     * `markStarted` onwards and this must become a no-op rather than killing a
     * live run.
     */
    async markDispatchFailed(runId: string, errorMessage: string): Promise<void> {
        const ok = await this.casTerminal(runId, QUEUED_ONLY, { status: 'failed', errorMessage });
        if (!ok) await this.warnTerminalNoOp(runId, 'markDispatchFailed');
    }

    /**
     * Persist the agent-memory session id once `AgentRunService.execute()`
     * has opened a session at the start of the run. Best-effort — if
     * this fails, the run continues (memory is not on the critical path).
     */
    async setMemorySessionId(runId: string, memorySessionId: string): Promise<void> {
        await this.repository.update(runId, { memorySessionId });
    }

    /**
     * Find an in-flight run for the (taskId, agentId) pair — used by
     * the agent-chat-reply dedup guard (architecture/security §8 — T6
     * mitigation): if a chat-triggered run is already running for the
     * same task + agent, the new mention appends context to the
     * in-flight run rather than dispatching a 2nd run.
     */
    async findInFlightForTaskAgent(taskId: string, agentId: string): Promise<AgentRun | null> {
        return this.repository
            .createQueryBuilder('run')
            .where('run.taskId = :taskId', { taskId })
            .andWhere('run.agentId = :agentId', { agentId })
            .andWhere('run.status IN (:...statuses)', {
                statuses: ['queued', 'running'] satisfies AgentRunStatus[],
            })
            .orderBy('run.createdAt', 'DESC')
            .getOne();
    }

    /**
     * Most-recent queued / running run for an Agent regardless of trigger
     * kind. Kept as a legacy fallback for Trigger payloads created before
     * workers started carrying explicit AgentRun ids.
     */
    async findInFlightForAgent(agentId: string): Promise<AgentRun | null> {
        return this.repository
            .createQueryBuilder('run')
            .where('run.agentId = :agentId', { agentId })
            .andWhere('run.status IN (:...statuses)', {
                statuses: ['queued', 'running'] satisfies AgentRunStatus[],
            })
            .orderBy('run.createdAt', 'DESC')
            .getOne();
    }
}
