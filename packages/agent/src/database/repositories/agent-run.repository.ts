import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import type { GateStatus, TaskAcceptanceCheck, TaskCheckResult } from '@ever-works/contracts';
import { AgentRun, AgentRunStatus, AgentRunTriggerKind } from '../../entities/agent-run.entity';
import { RUN_COST_SETTLER, type RunCostSettler } from '../run-cost-settler';

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
        // Pricing Wave 9 M2 — run-cost settlement seam. Terminal writes
        // are the ONE choke point every run lifecycle path shares (the
        // worker's RPC proxy included), so the metering→credits debit
        // hangs off them here. @Optional(): bound by the api-side
        // @Global() SubscriptionsModule; absent in unit tests and
        // installs without the credits stack — every hook site no-ops.
        @Optional()
        @Inject(RUN_COST_SETTLER)
        private readonly runCostSettler?: RunCostSettler,
    ) {}

    /**
     * Fire the run-cost settlement for a run that just went terminal.
     * Best-effort BY CONTRACT — a settlement failure must never fail (or
     * bubble into) the terminal write that hosted it; the settler itself
     * also never rejects, this guard is defence-in-depth. Awaited (not
     * fire-and-forget) so callers that need read-your-write semantics on
     * `agent_runs.costCents` — and the tests — observe a completed
     * settlement when the terminal write resolves.
     */
    private async settleRunCost(runId: string): Promise<void> {
        if (!this.runCostSettler) return;
        try {
            await this.runCostSettler.settleRun(runId);
        } catch (err) {
            this.logger.warn(
                `AgentRun ${runId}: run-cost settlement failed (ignored): ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
        }
    }

    async findById(id: string): Promise<AgentRun | null> {
        return this.repository.findOne({ where: { id } });
    }

    /**
     * Kanban run cockpit (Wave 2) — batch-load runs for the `includeRun`
     * list embed. One IN query, no N+1.
     *
     * @internal Security: unscoped by design — callers MUST pass only ids
     * derived server-side from rows the acting user already owns (the
     * Tasks list hands over its own `latestRunId` pointers, never client
     * input). HTTP handlers must not expose this with caller-supplied ids.
     */
    async findByIds(ids: string[]): Promise<AgentRun[]> {
        // TypeORM renders `In([])` as invalid SQL on some drivers; and an
        // empty batch has an obvious answer anyway.
        if (ids.length === 0) return [];
        return this.repository.find({ where: { id: In(ids) } });
    }

    /**
     * Kanban run cockpit (Wave 2) — worker-side telemetry feed. A single
     * `repository.update` so the worker can stream progress (current
     * activity line, token counter, changed-files count) without touching
     * status columns; the status lifecycle stays exclusively with the
     * CAS-guarded transitions above. Best-effort — callers swallow
     * failures, telemetry must never fail a run.
     */
    async updateTelemetry(
        runId: string,
        patch: {
            currentActivity?: string | null;
            totalTokens?: number | null;
            changedFilesCount?: number | null;
        },
    ): Promise<void> {
        await this.repository.update(runId, patch);
    }

    /**
     * Run telemetry — ACCUMULATE token usage onto `agent_runs.totalTokens`.
     *
     * Separate from {@link updateTelemetry} (which sets an absolute value)
     * because the caller — `AgentRunService.runToolLoop` — only ever knows
     * ONE round-trip's usage, and the same run's loop can be re-entered
     * (the Wave 3 M5 red-gate iterate loop calls `execute()` again on the
     * same run). Folding the delta in here keeps the counter monotonic
     * across attempts without the loop needing to read the row itself.
     *
     * Read-modify-write rather than a raw `SET col = col + :delta`: the
     * three supported drivers (postgres / better-sqlite3 / mysql) do not
     * share an identifier-quoting style, and a single run's tool loop is
     * the only writer of this column. NULL (pre-column rows, runs that
     * never reported) is treated as 0.
     *
     * Best-effort by contract: a missing row is a no-op and a non-positive
     * / non-finite delta writes nothing. Callers additionally guard —
     * telemetry must never fail a run.
     */
    async addTokens(runId: string, delta: number): Promise<void> {
        if (!Number.isFinite(delta) || delta <= 0) return;
        const row = await this.repository.findOne({
            where: { id: runId },
            select: { id: true, totalTokens: true },
        });
        if (!row) return;
        await this.repository.update(runId, {
            totalTokens: (row.totalTokens ?? 0) + Math.trunc(delta),
        });
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
        /**
         * Wave 4 M2 — denormalized Work scope of the cancelled row, so the
         * caller can drain the concurrency queue for that Work after a
         * successful cancel. Null for Work-less runs.
         */
        workId?: string | null;
    }> {
        const run = await this.repository.findOne({
            where: { id: runId, userId },
            select: ['id', 'status', 'triggerRunId', 'workId'],
        });
        if (!run) return { found: false };
        if (run.status !== 'queued' && run.status !== 'running') {
            return {
                found: true,
                previousStatus: run.status,
                triggerRunId: run.triggerRunId,
                workId: run.workId ?? null,
            };
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
                workId: run.workId ?? null,
            };
        }
        // Wave 9 M2 — a user-cancelled run consumed provider spend up to
        // the moment it was cancelled; settle what was actually metered.
        await this.settleRunCost(runId);
        return {
            found: true,
            previousStatus: run.status,
            triggerRunId: run.triggerRunId,
            workId: run.workId ?? null,
        };
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
        Pick<
            AgentRun,
            | 'id'
            | 'agentId'
            | 'triggerKind'
            | 'status'
            | 'startedAt'
            | 'createdAt'
            | 'workId'
            | 'awaitingInput'
        >[]
    > {
        return (
            this.repository
                .createQueryBuilder('run')
                .select([
                    'run.id',
                    'run.agentId',
                    'run.triggerKind',
                    'run.status',
                    'run.startedAt',
                    'run.createdAt',
                    // Wave 4 M2 — the sweeper drains the concurrency queue for
                    // every Work whose stuck run it just reaped.
                    'run.workId',
                    // Wave 4 M5 — selected so the sweeper can re-assert the
                    // never-reap-awaiting_input rule in the service layer too.
                    'run.awaitingInput',
                ])
                .where('run.status IN (:...statuses)', { statuses: NON_TERMINAL })
                // Wave 4 M5 — a run parked on a human question is NOT stuck; it is
                // waiting, possibly for days. Reaping it is the production bug this
                // predicate exists to prevent, so the exemption lives in the SQL
                // (and again in `AgentRunSweeperService`, belt-and-braces). The
                // NULL arm covers rows written before the column existed.
                .andWhere('(run.awaitingInput IS NULL OR run.awaitingInput = :notAwaiting)', {
                    notAwaiting: false,
                })
                .andWhere('COALESCE(run.startedAt, run.createdAt) <= :cutoff', { cutoff })
                .orderBy('COALESCE(run.startedAt, run.createdAt)', 'ASC')
                .limit(limit)
                .getMany()
        );
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
        // Wave 9 M2 — every input id is terminal after this statement
        // (either this bulk CAS won or a worker's own terminal write did,
        // which already settled). Settling all ids is safe: settlement is
        // idempotent (`run:{runId}` ledger key) and zero-event runs skip.
        for (const runId of runIds) {
            await this.settleRunCost(runId);
        }
        return result.affected ?? 0;
    }

    async createQueued(args: {
        agentId: string;
        userId: string;
        triggerKind: AgentRunTriggerKind;
        taskId?: string | null;
        chatMessageId?: string | null;
        /** Wave 4 M1 — denormalized from `task.workId` at creation when present. */
        workId?: string | null;
        /** Wave 4 M2 — set to `concurrency-limit` when the dispatch gate parks the run. */
        queuedReason?: string | null;
        /** Wave 4 M1 — pipeline plugin id when known at creation. */
        runnerKind?: string | null;
        organizationId?: string | null;
    }): Promise<AgentRun> {
        const run = this.repository.create({
            agentId: args.agentId,
            userId: args.userId,
            triggerKind: args.triggerKind,
            status: 'queued',
            taskId: args.taskId ?? null,
            chatMessageId: args.chatMessageId ?? null,
            workId: args.workId ?? null,
            queuedReason: args.queuedReason ?? null,
            runnerKind: args.runnerKind ?? null,
            // Only stamp when explicitly provided — the ambient scope
            // subscriber (EW-657) remains the default writer.
            ...(args.organizationId !== undefined ? { organizationId: args.organizationId } : {}),
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
        // Wave 9 M2 — settle metered cost → credits debit on the winning
        // terminal write only; a CAS loser's re-settle would be a
        // harmless idempotent no-op but is skipped to avoid double work.
        if (ok) await this.settleRunCost(runId);
    }

    async markFailed(runId: string, errorMessage: string): Promise<void> {
        const ok = await this.casTerminal(runId, NON_TERMINAL, { status: 'failed', errorMessage });
        if (!ok) await this.warnTerminalNoOp(runId, 'markFailed');
        // Wave 9 M2 — failed runs still consumed provider spend; the
        // accumulator sums whatever the run actually metered (often 0).
        if (ok) await this.settleRunCost(runId);
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
        // Wave 9 M2 — a dispatch-failed run normally metered nothing (the
        // settler skips runs with zero tagged events); kept for the ONE
        // terminal choke-point invariant.
        if (ok) await this.settleRunCost(runId);
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
     * Pricing Wave 9 M2 — stamp the run's cumulative metered cost
     * (sum of its tagged `plugin_usage_events.costCents`) onto the
     * Wave-4 `costCents` rollup column. Written by the run-cost
     * settlement on terminal transitions; deliberately NOT part of
     * {@link updateTelemetry}'s worker-facing whitelist — workers
     * self-report tokens/activity, but cost comes from the metering
     * pipeline only.
     */
    async stampCostCents(runId: string, costCents: number): Promise<void> {
        await this.repository.update(runId, { costCents });
    }

    /**
     * Streaming-terminal M6 — patch the run's terminal lifecycle columns.
     * Field-by-field construction from an explicit whitelist: callers
     * (the internal heartbeat/state endpoints) receive worker-supplied
     * payloads, and none of those may ever write status/summary/etc.
     */
    async updateTerminalColumns(
        runId: string,
        patch: {
            persistent?: boolean;
            terminalState?: string | null;
            terminalEndedReason?: string | null;
            terminalProviderId?: string | null;
            cliSessionId?: string | null;
            lastHeartbeatAt?: Date | null;
            lastFrameSeq?: number | null;
        },
    ): Promise<void> {
        const update: Record<string, unknown> = {};
        if (patch.persistent !== undefined) update.persistent = patch.persistent;
        if (patch.terminalState !== undefined) update.terminalState = patch.terminalState;
        if (patch.terminalEndedReason !== undefined)
            update.terminalEndedReason = patch.terminalEndedReason;
        if (patch.terminalProviderId !== undefined)
            update.terminalProviderId = patch.terminalProviderId;
        if (patch.cliSessionId !== undefined) update.cliSessionId = patch.cliSessionId;
        if (patch.lastHeartbeatAt !== undefined) update.lastHeartbeatAt = patch.lastHeartbeatAt;
        if (patch.lastFrameSeq !== undefined) update.lastFrameSeq = patch.lastFrameSeq;
        if (Object.keys(update).length === 0) return;
        await this.repository.update(runId, update);
    }

    /**
     * Streaming-terminal M6 — sweeper input: runs whose terminal claims
     * to be live (`starting`/`attached`) but whose heartbeat is older
     * than the cutoff. The sweeper marks them crashed and publishes a
     * pinned exit frame so no viewer ever stares at a frozen pane.
     */
    async findStaleTerminalRuns(cutoff: Date, limit = 50): Promise<AgentRun[]> {
        return this.repository
            .createQueryBuilder('run')
            .where('run.terminalState IN (:...states)', { states: ['starting', 'attached'] })
            .andWhere('(run.lastHeartbeatAt IS NULL OR run.lastHeartbeatAt < :cutoff)', {
                cutoff,
            })
            .orderBy('run.createdAt', 'ASC')
            .take(limit)
            .getMany();
    }

    /**
     * Quality gates (Wave 3 M2) — persist the gate columns for one run.
     *
     * Explicit field-by-field whitelist, mirroring
     * {@link updateTerminalColumns}: the callers (the dispatch-freeze
     * snapshot in `agent-task-execute` and `TaskGateRunnerService`) hand
     * over worker-influenced payloads, and none of those may ever write
     * status/summary/telemetry columns through this path. Deliberately no
     * status CAS — the gate columns are additive facts about the run, not
     * lifecycle transitions, and the runner reports them right before the
     * terminal write.
     */
    async updateGateResults(
        runId: string,
        patch: {
            resolvedChecks?: TaskAcceptanceCheck[] | null;
            checkResults?: TaskCheckResult[] | null;
            gateStatus?: GateStatus | null;
            gateAttempts?: number;
        },
    ): Promise<void> {
        const update: Record<string, unknown> = {};
        if (patch.resolvedChecks !== undefined) update.resolvedChecks = patch.resolvedChecks;
        if (patch.checkResults !== undefined) update.checkResults = patch.checkResults;
        if (patch.gateStatus !== undefined) update.gateStatus = patch.gateStatus;
        if (patch.gateAttempts !== undefined) update.gateAttempts = patch.gateAttempts;
        if (Object.keys(update).length === 0) return;
        await this.repository.update(runId, update);
    }

    /**
     * Record the per-run workspace audit (worktree-per-Task isolation).
     * The Task row keeps the durable branch identity; this is the
     * run-scoped record for debugging and the run cockpit.
     */
    async setWorkspaceMeta(
        runId: string,
        workspaceMeta: NonNullable<AgentRun['workspaceMeta']>,
    ): Promise<void> {
        await this.repository.update(runId, { workspaceMeta });
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
     * Most-recent run dispatched for a Task, any agent, any status —
     * the "latest run" the quality-gate transition rule (Wave 3 M8)
     * reads `gateStatus` from. Authoritative (queries the runs table
     * directly) rather than following the best-effort `tasks.latestRunId`
     * denorm pointer, because a policy gate must not depend on
     * board-decoration telemetry.
     *
     * @internal Security: unscoped — callers must have verified Task
     * ownership through another path (TaskTransitionService receives an
     * owner-scoped Task row).
     */
    async findLatestForTask(taskId: string): Promise<AgentRun | null> {
        return this.repository
            .createQueryBuilder('run')
            .where('run.taskId = :taskId', { taskId })
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

    // ── Run orchestration (Wave 4 M2/M3) ───────────────────────────

    /**
     * In-flight = `running`, plus `queued` rows that were actually handed
     * to the job runtime (`queuedReason IS NULL`). Rows parked by the
     * dispatch gate (`queuedReason = 'concurrency-limit'`) are WAITING for
     * capacity, not consuming it — counting them would deadlock the drain:
     * the parked run itself would keep the count at the limit forever.
     */
    private inFlightQb(alias = 'run') {
        return this.repository
            .createQueryBuilder(alias)
            .where(`${alias}.status IN (:...statuses)`, {
                statuses: ['queued', 'running'] satisfies AgentRunStatus[],
            })
            .andWhere(`${alias}.queuedReason IS NULL`);
    }

    /** Per-Work in-flight count for the dispatch gate. */
    async countInFlightForWork(workId: string): Promise<number> {
        return this.inFlightQb().andWhere('run.workId = :workId', { workId }).getCount();
    }

    /** Per-user in-flight count (the org valve for org-less personal runs). */
    async countInFlightForUser(userId: string): Promise<number> {
        return this.inFlightQb().andWhere('run.userId = :userId', { userId }).getCount();
    }

    /** Per-organization in-flight count for the dispatch gate. */
    async countInFlightForOrganization(organizationId: string): Promise<number> {
        return this.inFlightQb()
            .andWhere('run.organizationId = :organizationId', { organizationId })
            .getCount();
    }

    /**
     * Oldest run parked by the dispatch gate for this Work — FIFO drain
     * order (priority-aware ordering is a documented later milestone).
     */
    async findOldestQueuedForConcurrency(
        workId: string,
        queuedReason: string,
    ): Promise<AgentRun | null> {
        return this.repository
            .createQueryBuilder('run')
            .where('run.workId = :workId', { workId })
            .andWhere('run.status = :status', { status: 'queued' satisfies AgentRunStatus })
            .andWhere('run.queuedReason = :queuedReason', { queuedReason })
            .orderBy('run.createdAt', 'ASC')
            .getOne();
    }

    /**
     * CAS-claim a parked run for dispatch: clears `queuedReason` only
     * while the row is still `queued` AND still parked, so two drains
     * racing for the same run resolve to exactly one dispatcher. Returns
     * whether THIS caller won the claim.
     */
    async claimQueuedForDispatch(runId: string, queuedReason: string): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(AgentRun)
            .set({ queuedReason: null })
            .where('id = :id', { id: runId })
            .andWhere('status = :status', { status: 'queued' satisfies AgentRunStatus })
            .andWhere('queuedReason = :queuedReason', { queuedReason })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Roll a drain-claimed run back to parked after its dispatch could
     * not be attempted (no dispatcher bound). No-clobber: only a still-
     * `queued` row with a cleared reason is restored.
     */
    async restoreQueuedReason(runId: string, queuedReason: string): Promise<void> {
        await this.repository
            .createQueryBuilder()
            .update(AgentRun)
            .set({ queuedReason })
            .where('id = :id', { id: runId })
            .andWhere('status = :status', { status: 'queued' satisfies AgentRunStatus })
            .andWhere('queuedReason IS NULL')
            .execute();
    }

    // ── Run steering (Wave 4 M5) ───────────────────────────────────

    /**
     * Append one steering message to a LIVE run's pending-input queue.
     *
     * Read-modify-write rather than a SQL array append: `pendingInput` is a
     * `simple-json` (text) column, and the two supported drivers (Postgres in
     * prod, sqlite in e2e) have no portable JSON-append. The status re-check
     * inside the UPDATE's WHERE is what makes it safe: a run that went terminal
     * between the read and the write takes no message, and the caller is told
     * so (`false`) and starts a new run instead. Two concurrent steers on the
     * same live run can drop one message under a lost update — acceptable for a
     * human-paced control channel, and strictly better than a terminal run
     * silently swallowing input.
     *
     * `awaitingInput` is cleared in the SAME statement: an answered question is
     * no longer a question, and doing it here means no window where the run is
     * both parked and holding fresh input.
     */
    async appendPendingInput(runId: string, message: string): Promise<boolean> {
        const run = await this.repository.findOne({
            where: { id: runId },
            select: ['id', 'status', 'pendingInput'],
        });
        if (!run) return false;
        if (!NON_TERMINAL.includes(run.status)) return false;
        const queue = Array.isArray(run.pendingInput) ? [...run.pendingInput] : [];
        queue.push(message);
        const result = await this.repository
            .createQueryBuilder()
            .update(AgentRun)
            .set({ pendingInput: queue, awaitingInput: false })
            .where('id = :id', { id: runId })
            .andWhere('status IN (:...statuses)', { statuses: NON_TERMINAL })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Drain the steering signals for the executing run: the queued input
     * messages (cleared as they are handed over, so the same message is never
     * injected twice) plus the cooperative interrupt flag.
     *
     * Called once per model round-trip by `AgentRunService.runToolLoop`, i.e.
     * at most `TOOL_LOOP_MAX_ITERATIONS` times per run, and it only writes when
     * there was actually something queued.
     */
    async takeSteeringSignals(runId: string): Promise<{
        pendingInput: string[];
        interruptRequested: boolean;
    }> {
        const run = await this.repository.findOne({
            where: { id: runId },
            select: ['id', 'pendingInput', 'interruptRequested'],
        });
        if (!run) return { pendingInput: [], interruptRequested: false };
        const pendingInput = Array.isArray(run.pendingInput) ? run.pendingInput : [];
        if (pendingInput.length > 0) {
            await this.repository.update(runId, { pendingInput: null });
        }
        return { pendingInput, interruptRequested: run.interruptRequested === true };
    }

    /**
     * Request a cooperative stop. CAS-guarded on `queued|running` so an
     * interrupt racing a terminal write cannot resurrect a finished run's
     * flag. Returns whether the request was recorded.
     */
    async requestInterrupt(runId: string): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(AgentRun)
            .set({ interruptRequested: true })
            .where('id = :id', { id: runId })
            .andWhere('status IN (:...statuses)', { statuses: NON_TERMINAL })
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /**
     * Lifecycle signal: the run is (or is no longer) parked on a human.
     *
     * Deliberately NOT status-guarded — a run parks itself as its LAST act
     * before finishing, so the write frequently lands on a row that is already
     * terminal, and that is the correct state to record (the Sessions view
     * shows "awaiting input" on a finished-but-parked run, and Resume is
     * offered from exactly there).
     */
    async setAwaitingInput(runId: string, awaitingInput: boolean): Promise<void> {
        await this.repository.update(runId, { awaitingInput });
    }

    /**
     * Seed a freshly-created run with the conversation identity + first
     * message it should resume from. Field-by-field whitelist, mirroring
     * {@link updateTerminalColumns}.
     */
    async seedResumeContext(
        runId: string,
        patch: { cliSessionId?: string | null; pendingInput?: string[] | null },
    ): Promise<void> {
        const update: Record<string, unknown> = {};
        if (patch.cliSessionId !== undefined) update.cliSessionId = patch.cliSessionId;
        if (patch.pendingInput !== undefined) update.pendingInput = patch.pendingInput;
        if (Object.keys(update).length === 0) return;
        await this.repository.update(runId, update);
    }

    /**
     * Sessions list (Wave 4 M3) — owner-scoped, filterable, paginated.
     * `userId` is mandatory and always applied at the repository layer:
     * this is the HTTP-facing method, so cross-user rows must be
     * unreachable even if a future controller forgets its own guard.
     */
    async listSessionsForUser(
        userId: string,
        filters: {
            status?: AgentRunStatus;
            workId?: string;
            agentId?: string;
            taskId?: string;
            triggerKind?: AgentRunTriggerKind;
        },
        limit = 25,
        offset = 0,
    ): Promise<[AgentRun[], number]> {
        const qb = this.repository
            .createQueryBuilder('run')
            .where('run.userId = :userId', { userId });
        if (filters.status) {
            qb.andWhere('run.status = :status', { status: filters.status });
        }
        if (filters.workId) {
            qb.andWhere('run.workId = :workId', { workId: filters.workId });
        }
        if (filters.agentId) {
            qb.andWhere('run.agentId = :agentId', { agentId: filters.agentId });
        }
        if (filters.taskId) {
            qb.andWhere('run.taskId = :taskId', { taskId: filters.taskId });
        }
        if (filters.triggerKind) {
            qb.andWhere('run.triggerKind = :triggerKind', { triggerKind: filters.triggerKind });
        }
        return qb.orderBy('run.createdAt', 'DESC').take(limit).skip(offset).getManyAndCount();
    }

    /**
     * Per-Work session summary (Wave 4 M3) — one grouped scan over
     * `(workId, status)` instead of four counts. CASE/SUM is portable
     * across Postgres and sqlite (the e2e suite runs on sqlite);
     * `awaitingInput = :true` binds a real boolean so both drivers
     * compare their native representation.
     */
    async summarizeForWork(workId: string): Promise<{
        running: number;
        queued: number;
        awaiting: number;
        failedLast24h: number;
    }> {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const raw = await this.repository
            .createQueryBuilder('run')
            .select(`SUM(CASE WHEN run.status = 'running' THEN 1 ELSE 0 END)`, 'running')
            .addSelect(`SUM(CASE WHEN run.status = 'queued' THEN 1 ELSE 0 END)`, 'queued')
            .addSelect(
                `SUM(CASE WHEN run.awaitingInput = :isAwaiting AND run.status IN ('queued', 'running') THEN 1 ELSE 0 END)`,
                'awaiting',
            )
            .addSelect(
                `SUM(CASE WHEN run.status = 'failed' AND run.finishedAt >= :cutoff THEN 1 ELSE 0 END)`,
                'failedLast24h',
            )
            .where('run.workId = :workId', { workId })
            .setParameters({ isAwaiting: true, cutoff })
            .getRawOne<{
                running: string | number | null;
                queued: string | number | null;
                awaiting: string | number | null;
                failedLast24h: string | number | null;
            }>();
        return {
            running: Number(raw?.running ?? 0),
            queued: Number(raw?.queued ?? 0),
            awaiting: Number(raw?.awaiting ?? 0),
            failedLast24h: Number(raw?.failedLast24h ?? 0),
        };
    }
}
