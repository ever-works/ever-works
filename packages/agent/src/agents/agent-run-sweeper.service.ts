import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';

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
    /** True when the batch filled — more stuck rows remain for the next tick. */
    batchLimitReached: boolean;
    oldestAgeMs: number | null;
    byKind: Record<string, number>;
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
 */
@Injectable()
export class AgentRunSweeperService {
    private readonly logger = new Logger(AgentRunSweeperService.name);

    constructor(private readonly runs: AgentRunRepository) {}

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

        const stuck = await this.runs.findStuckNonTerminal(cutoff, limit);
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

        const swept = await this.runs.markStuckFailed(
            stuck.map((r) => r.id),
            `${STUCK_SWEEP_PREFIX}: no worker checkpoint for ${cutoffMinutes}m`,
        );

        const batchLimitReached = stuck.length >= limit;
        // Every non-zero sweep is an anomaly — a worker died. Loud on purpose:
        // a silent sweeper hides the upstream failure it is compensating for.
        // The per-kind breakdown is what separates "one node was evicted" from
        // "agent-task-execute is systematically dying".
        this.logger.warn(
            `AgentRun sweep: reaped ${swept}/${stuck.length} stuck run(s) — ` +
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

        return {
            enabled: true,
            cutoffMinutes,
            scanned: stuck.length,
            swept,
            batchLimitReached,
            oldestAgeMs,
            byKind,
        };
    }
}
