import { Injectable, Logger, Optional } from '@nestjs/common';
import { config } from '../config';
import {
    ATTENTION_REASON_QUEUED_TOO_LONG,
    ATTENTION_REASON_STALE_PARKED,
    AgentRunRepository,
    STALE_PARK_SUMMARY_PREFIX,
} from '../database/repositories/agent-run.repository';
import { RunDispatchGateService } from './run-dispatch-gate.service';
import { AgentEscalationService } from './agent-escalation.service';
import { NotificationService } from '../notifications/notification.service';
import type { AgentRun } from '../entities/agent-run.entity';

/**
 * Error message prefix for a swept run.
 *
 * Deliberately distinct from `dispatch-failed:` and `enqueue-failed:` and
 * containing neither substring, so the existing specs that pin those (all
 * `toContain`/`stringContaining`) cannot collide with it. Kept short because it
 * renders as the user-facing cell in the Activity tab — a swept run has no
 * `summary`, so this string is what the user reads.
 */
export const STUCK_SWEEP_PREFIX = 'stuck-timeout';

export interface AgentRunSweepSummary {
    enabled: boolean;
    cutoffMinutes: number;
    /** Rows matching the stuck predicate this tick (bounded by the batch size). */
    scanned: number;
    /** Rows actually transitioned. Lower than `scanned` when a worker won the CAS race. */
    swept: number;
    /**
     * State-aware sweeper (Wave 4 M6) — of `swept`, how many were
     * checkpoint-and-PARKED (stale `running`, conversation kept,
     * resumable) rather than hard-failed. `swept - parked` is the reaped
     * count.
     */
    parked: number;
    /** True when the batch filled — more stuck rows remain for the next tick. */
    batchLimitReached: boolean;
    oldestAgeMs: number | null;
    byKind: Record<string, number>;
}

/** Outcome of the queued-too-long surfacing pass (Wave 4 M6). */
export interface QueuedTooLongSweepSummary {
    enabled: boolean;
    thresholdMinutes: number;
    /** Rows over the bound and not yet flagged. */
    scanned: number;
    /** Rows this tick actually flagged (CAS winners). */
    flagged: number;
    /** Of those, how many produced an owner notification. */
    notified: number;
}

/**
 * Reaps `agent_runs` rows abandoned by a worker that died without reaching any
 * checkpoint. Nothing else does: `recoverStuckRunning()` sweeps `agents` rows
 * only, so a hard-killed run sat in `queued`/`running` forever and kept
 * `findInFlightForTaskAgent` suppressing dispatch for that task-agent pair.
 *
 * 🛑 The cutoff is intentionally measured in HOURS, and must stay that way.
 * `apps/web/e2e/flow-agent-runs-pagination.spec.ts` asserts on failed runs with
 * a null `startedAt`; a swept `running` row has `startedAt` set, so lowering
 * the cutoff to test-visible durations — or exposing this sweep on an
 * e2e-reachable HTTP route — would make that spec flaky for a real reason.
 *
 * Safety rests on more than the cutoff. The worker also honours
 * `markStarted`'s CAS result and treats a `failed` status as an abort signal at
 * its next checkpoint, so even in the impossible case where a sweep lands on a
 * live run, the worker bails before applying side effects.
 *
 * ## State-aware policy (Wave 4 M6)
 *
 * One TTL used to produce one verdict (`failed`) for three different
 * situations. It now branches on the run's actual state:
 *
 * | state                     | policy                                       |
 * |---------------------------|----------------------------------------------|
 * | `awaitingInput`           | **never reaped, never flagged.** Exempt from  |
 * |                           | every TTL — it is waiting, not stuck.         |
 * | `running` + stale         | **checkpoint-and-park**: terminal `completed` |
 * |                           | + `terminalEndedReason='parked'`, so `resume` |
 * |                           | can revive the conversation. Not an error.    |
 * | `queued` + stale          | hard-fail (unchanged): a queued row never      |
 * |                           | started, so there is nothing to checkpoint.    |
 * | `queued` + over the bound | **surface**: flag + notify, never reap.        |
 *
 * Every threshold is env-configurable (`AGENT_RUN_STUCK_SWEEP_MINUTES`,
 * `AGENT_RUN_QUEUED_TOO_LONG_MINUTES`, `AGENT_RUN_STALE_PARK_ENABLED`,
 * batch sizes) with the defaults documented on the config getters.
 */
@Injectable()
export class AgentRunSweeperService {
    private readonly logger = new Logger(AgentRunSweeperService.name);

    constructor(
        private readonly runs: AgentRunRepository,
        // Run orchestration (Wave 4 M2) — drain safety net: after reaping
        // stuck runs, promote parked runs for the affected Works. Appended
        // LAST + Optional so positional spec constructors keep compiling.
        @Optional() private readonly dispatchGate?: RunDispatchGateService,
        // Wave 4 M6 — the attention surface. Both @Optional() and both
        // appended after the existing positional args, for the same
        // reason: unit tests construct this service positionally.
        @Optional() private readonly notifications?: NotificationService,
        @Optional() private readonly escalations?: AgentEscalationService,
    ) {}

    /**
     * Zero-arg by design: the worker resolves this service as a superjson RPC
     * proxy, so arguments would have to survive serialization. Everything it
     * needs comes from config.
     */
    async sweepStuckRuns(): Promise<AgentRunSweepSummary> {
        const cutoffMinutes = config.agents.getRunStuckSweepMinutes();
        const empty: AgentRunSweepSummary = {
            enabled: true,
            cutoffMinutes,
            scanned: 0,
            swept: 0,
            parked: 0,
            batchLimitReached: false,
            oldestAgeMs: null,
            byKind: {},
        };

        if (!config.agents.getRunSweeperEnabled()) {
            this.logger.log('AgentRun sweeper disabled (AGENT_RUN_SWEEPER_ENABLED=false)');
            return { ...empty, enabled: false };
        }

        const limit = config.agents.getRunStuckSweepBatch();
        const now = Date.now();
        const cutoff = new Date(now - cutoffMinutes * 60_000);

        const scanned = await this.runs.findStuckNonTerminal(cutoff, limit);
        // Run steering (Wave 4 M5) — THE hard rule of this plan: a run parked
        // on a human question must NEVER be reaped by a TTL sweep. It is not
        // stuck, it is waiting, possibly for days, and killing it destroys
        // work nobody can recover. The repository predicate already excludes
        // these rows; re-asserting it here is deliberate belt-and-braces —
        // this service is the last gate before `markStuckFailed`, and an
        // older API replica (or a future second caller) handing back an
        // awaiting row must still not reap it.
        const stuck = scanned.filter((row) => row.awaitingInput !== true);
        const skippedAwaiting = scanned.length - stuck.length;
        if (skippedAwaiting > 0) {
            this.logger.log(
                `AgentRun sweep: skipped ${skippedAwaiting} run(s) awaiting human input (never reaped).`,
            );
        }
        if (stuck.length === 0) {
            // Logged even on zero so the ABSENCE of sweeps is positively
            // confirmed rather than inferred from silence.
            this.logger.log(`AgentRun sweep: none stuck (cutoff ${cutoffMinutes}m)`);
            return empty;
        }

        const byKind: Record<string, number> = {};
        let oldestAgeMs = 0;
        for (const row of stuck) {
            byKind[row.triggerKind] = (byKind[row.triggerKind] ?? 0) + 1;
            const at = (row.startedAt ?? row.createdAt)?.getTime?.();
            if (typeof at === 'number') oldestAgeMs = Math.max(oldestAgeMs, now - at);
        }

        // Wave 4 M6 — split the batch by STATE, not by age. A `running`
        // row has a live conversation behind it (`cliSessionId`) and gets
        // checkpoint-and-parked; a `queued` row never started, so there is
        // nothing to checkpoint and the pre-M6 hard fail is still right.
        const parkEnabled = config.agents.getRunStaleParkEnabled();
        const parkable = parkEnabled ? stuck.filter((row) => row.status === 'running') : [];
        const parkableIds = new Set(parkable.map((row) => row.id));
        const reapable = stuck.filter((row) => !parkableIds.has(row.id));

        let parked = 0;
        if (parkable.length > 0) {
            parked = await this.runs.parkStaleRunning(
                parkable.map((r) => r.id),
                `${STALE_PARK_SUMMARY_PREFIX}: no worker checkpoint for ${cutoffMinutes}m — ` +
                    `session parked, resume to continue`,
            );
        }

        const reaped =
            reapable.length > 0
                ? await this.runs.markStuckFailed(
                      reapable.map((r) => r.id),
                      `${STUCK_SWEEP_PREFIX}: no worker checkpoint for ${cutoffMinutes}m`,
                  )
                : 0;
        const swept = parked + reaped;

        // A parked run is a run nobody is driving any more. Record it so
        // the Task detail + digest can say "this stopped, here is how to
        // pick it up" instead of the user finding it by scrolling.
        for (const row of parkable) {
            await this.recordParkEscalation(row, cutoffMinutes);
        }

        // Measured on the RAW scan, not the awaiting-filtered set: the batch
        // is what the query returned, so a page full of skipped rows still
        // means "more remain, come back next tick".
        const batchLimitReached = scanned.length >= limit;
        // Every non-zero sweep is an anomaly — a worker died. Loud on purpose:
        // a silent sweeper hides the upstream failure it is compensating for.
        // The per-kind breakdown is what separates "one node was evicted" from
        // "agent-task-execute is systematically dying".
        this.logger.warn(
            `AgentRun sweep: parked ${parked}, reaped ${reaped} of ${stuck.length} stuck run(s) — ` +
                `cutoff=${cutoffMinutes}m oldest=${Math.round(oldestAgeMs / 60_000)}m ` +
                `byKind=${JSON.stringify(byKind)} ids=${JSON.stringify(
                    stuck.slice(0, 20).map((r) => r.id),
                )}`,
        );
        if (batchLimitReached) {
            // Never truncate silently — that is how a backlog never drains and
            // nobody notices.
            this.logger.warn(
                `AgentRun sweep: batch limit ${limit} reached — more stuck runs remain, next tick will continue`,
            );
        }

        // Run orchestration (Wave 4 M2) — drain safety net. Every reaped
        // OR parked run may have freed a concurrency slot; promote the
        // oldest parked run for each affected Work. Best-effort by
        // contract (the gate never throws from drainForWork), and only
        // when rows actually transitioned — a lost CAS race freed nothing.
        if (this.dispatchGate && swept > 0) {
            const workIds = [
                ...new Set(stuck.map((r) => r.workId).filter((w): w is string => !!w)),
            ];
            for (const workId of workIds) {
                await this.dispatchGate.drainForWork(workId);
            }
        }

        return {
            enabled: true,
            cutoffMinutes,
            scanned: stuck.length,
            swept,
            parked,
            batchLimitReached,
            oldestAgeMs,
            byKind,
        };
    }

    /**
     * State-aware sweeper (Wave 4 M6) — **surface** runs that have been
     * `queued` past the bound instead of letting them sit silently.
     *
     * This pass NEVER reaps and never transitions a run: a run that cannot
     * get capacity is a capacity problem, and killing it would destroy
     * queued work to hide a symptom. It stamps
     * `attentionReason='queued-too-long'` (which the Sessions list's
     * `attention=1` filter reads), notifies the owner once, and files an
     * escalation so the Task detail and the digest can show it.
     *
     * One-shot per run by construction: the scan excludes rows that
     * already carry an `attentionReason`, and the flag write is CAS'd, so
     * neither a second tick nor a second replica can double-notify.
     *
     * Zero-arg, like {@link sweepStuckRuns} — same superjson RPC proxy.
     */
    async sweepQueuedTooLong(): Promise<QueuedTooLongSweepSummary> {
        const thresholdMinutes = config.agents.getRunQueuedTooLongMinutes();
        const base: QueuedTooLongSweepSummary = {
            enabled: true,
            thresholdMinutes,
            scanned: 0,
            flagged: 0,
            notified: 0,
        };
        if (!config.agents.getRunSweeperEnabled() || thresholdMinutes <= 0) {
            return { ...base, enabled: false };
        }

        const limit = config.agents.getRunQueuedAttentionBatch();
        const cutoff = new Date(Date.now() - thresholdMinutes * 60_000);
        const candidates = await this.runs.findQueuedTooLong(cutoff, limit);
        if (candidates.length === 0) {
            return base;
        }

        let flagged = 0;
        let notified = 0;
        for (const run of candidates) {
            let won = false;
            try {
                won = await this.runs.setAttention(run.id, ATTENTION_REASON_QUEUED_TOO_LONG);
            } catch (error) {
                this.logger.warn(
                    `AgentRun queued-too-long: flag failed for ${run.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                continue;
            }
            // Lost the CAS — another tick/replica already flagged and
            // notified. Doing either again would double-notify.
            if (!won) continue;
            flagged += 1;

            const waitedMinutes = Math.max(
                thresholdMinutes,
                Math.round((Date.now() - (run.createdAt?.getTime?.() ?? Date.now())) / 60_000),
            );
            if (await this.notifyQueuedTooLong(run, waitedMinutes)) {
                notified += 1;
            }
            await this.recordQueuedTooLongEscalation(run, waitedMinutes);
        }

        this.logger.log(
            `AgentRun queued-too-long: flagged ${flagged}/${candidates.length} run(s) over ` +
                `${thresholdMinutes}m (notified ${notified}).`,
        );
        return { ...base, scanned: candidates.length, flagged, notified };
    }

    /**
     * Streaming-terminal M6 — reap sessions whose terminal claims to be
     * live but whose heartbeat went stale (crashed worker, killed pod).
     * Marks them `ended/crashed` and returns the run ids so the CALLER
     * (the worker-side sweeper task) can best-effort publish a pinned
     * `exit` frame through the relay — no viewer stares at a frozen
     * pane. Zero-arg like `sweepStuckRuns` (superjson RPC proxy).
     */
    async sweepStaleTerminalSessions(): Promise<{ swept: string[]; cutoffMinutes: number }> {
        const cutoffMinutes = 5;
        const cutoff = new Date(Date.now() - cutoffMinutes * 60_000);
        const stale = await this.runs.findStaleTerminalRuns(cutoff);
        const swept: string[] = [];
        for (const run of stale) {
            try {
                await this.runs.updateTerminalColumns(run.id, {
                    terminalState: 'ended',
                    terminalEndedReason: 'crashed',
                });
                swept.push(run.id);
            } catch (error) {
                this.logger.warn(
                    `terminal sweep failed for run ${run.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        return { swept, cutoffMinutes };
    }

    // ── internals ──────────────────────────────────────────────────

    /**
     * Best-effort by contract: neither a notification nor an escalation
     * may fail (or slow) a sweep tick. Every failure is logged so a silent
     * attention gap is impossible.
     */
    private async notifyQueuedTooLong(
        run: { id: string; userId: string; taskId?: string | null; queuedReason?: string | null },
        waitedMinutes: number,
    ): Promise<boolean> {
        if (!this.notifications) return false;
        try {
            await this.notifications.notifyAgentRunQueuedTooLong({
                userId: run.userId,
                runId: run.id,
                taskId: run.taskId ?? null,
                waitedMinutes,
                queuedReason: run.queuedReason ?? null,
            });
            return true;
        } catch (error) {
            this.logger.warn(
                `AgentRun queued-too-long: notify failed for ${run.id}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }
    }

    private async recordQueuedTooLongEscalation(
        run: {
            id: string;
            userId: string;
            agentId: string;
            taskId?: string | null;
            workId?: string | null;
            queuedReason?: string | null;
        },
        waitedMinutes: number,
    ): Promise<void> {
        if (!this.escalations) return;
        const persisted = await this.findPersistedRunForEscalation(run.id);
        if (!persisted) return;
        await this.escalations.record({
            userId: persisted.userId,
            reasonCode: 'queued-too-long',
            runId: persisted.id,
            taskId: persisted.taskId ?? null,
            workId: persisted.workId ?? null,
            agentId: persisted.agentId,
            tenantId: persisted.tenantId ?? null,
            organizationId: persisted.organizationId ?? null,
            summary: `Run has been queued for ${waitedMinutes} minutes without starting.`,
            decisionNeeded:
                'Decide whether to raise the concurrency limit for this Work/org, cancel the ' +
                'run, or let it keep waiting. Nothing was reaped — the run is still queued.',
            attempted: [
                {
                    label: 'dispatch',
                    outcome: persisted.queuedReason
                        ? `parked with reason '${persisted.queuedReason}'`
                        : 'queued, never handed to the job runtime',
                },
            ],
        });
    }

    private async recordParkEscalation(
        run: { id: string; agentId: string; workId?: string | null },
        cutoffMinutes: number,
    ): Promise<void> {
        if (!this.escalations) return;
        const persisted = await this.findPersistedRunForEscalation(run.id);
        if (!persisted) return;
        await this.escalations.record({
            userId: persisted.userId,
            reasonCode: 'run-parked',
            runId: persisted.id,
            taskId: persisted.taskId ?? null,
            workId: persisted.workId ?? null,
            agentId: persisted.agentId,
            tenantId: persisted.tenantId ?? null,
            organizationId: persisted.organizationId ?? null,
            summary: `Run was parked after ${cutoffMinutes} minutes with no worker checkpoint.`,
            decisionNeeded:
                'The conversation was kept and can be resumed. Decide whether to resume this ' +
                'run, or investigate why its worker stopped reporting.',
            attempted: [
                {
                    label: 'worker-heartbeat',
                    outcome: `no checkpoint for ${cutoffMinutes}m — process presumed dead`,
                },
            ],
        });
    }

    /**
     * The sweeper projections intentionally omit ownership columns. Escalations
     * are a best-effort side effect, so re-read the authoritative row and skip
     * the card when it cannot be loaded instead of guessing a Task's scope.
     */
    private async findPersistedRunForEscalation(runId: string): Promise<AgentRun | null> {
        try {
            const run = await this.runs.findById(runId);
            if (!run) {
                this.logger.warn(
                    `AgentRun escalation skipped for ${runId}: persisted run was not found.`,
                );
            }
            return run;
        } catch (error) {
            this.logger.warn(
                `AgentRun escalation skipped for ${runId}: persisted run lookup failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return null;
        }
    }
}

export { ATTENTION_REASON_QUEUED_TOO_LONG, ATTENTION_REASON_STALE_PARKED };
