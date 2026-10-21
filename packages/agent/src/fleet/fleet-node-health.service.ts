import { Injectable, Logger } from '@nestjs/common';
import {
    FLEET_HEALTH_HOURLY_RETENTION_MS,
    FLEET_HEALTH_RAW_RETENTION_MS,
    FLEET_HEALTH_SAMPLE_MIN_INTERVAL_MS,
    type FleetNodeHealthSnapshot,
    type FleetNodeHealthStored,
} from '@ever-works/contracts';
import { config } from '../config';
import {
    FleetNodeHealthSampleRepository,
    hourStart,
    rollUpHour,
    type FleetNodeHealthHourlyRow,
} from './fleet-node-health-sample.repository';
import type { FleetNodeHealthSample } from '../entities/fleet-node-health-sample.entity';

const HOUR_MS = 60 * 60_000;

/** An hour is rolled up only once it ended at least this long ago (clock skew between replicas). */
export const FLEET_HEALTH_ROLLUP_SETTLE_MS = 5 * 60_000;

/** At most this many hours are rolled up in one pass; a longer backlog clears over the next runs. */
export const FLEET_HEALTH_ROLLUP_MAX_HOURS_PER_RUN = 48;

/** A failed sample write is logged at most once per node per this long (U11). */
export const FLEET_HEALTH_DROP_LOG_INTERVAL_MS = 60 * 60_000;

export interface FleetHealthRollupSummary {
    /** False when `FLEET_HEALTH_HISTORY_ENABLED` is off — nothing was read or written. */
    enabled: boolean;
    /** Hours rolled up in this pass. */
    rolledHours: number;
    /** Hourly rows inserted (one per node with samples in a rolled hour). */
    hourlyRows: number;
    prunedRaw: number;
    prunedHourly: number;
}

/**
 * Computer health (FL-03) — the health HISTORY, behind
 * `FLEET_HEALTH_HISTORY_ENABLED` (default off).
 *
 *  - {@link shouldSample} / {@link record} — the sample writer called from
 *    every accepted heartbeat that carried a snapshot. At most one raw row
 *    per computer per 55 s (FR-18), judged from the row's own `sampledAt`
 *    marker so the floor holds across API replicas. The write is
 *    fire-and-forget: a failure is logged once per node per hour and NEVER
 *    fails, slows or retries the heartbeat (U11).
 *  - {@link rollupAndPrune} — the hourly pass the `fleet-health-rollup`
 *    task runs on the configured job runtime (Constitution IV): every
 *    completed hour not yet rolled up becomes one `hourly` row per node
 *    (means + peaks), then raw rows past 7 days and hourly rows past 90 days
 *    are deleted. Idempotent: a re-run inserts nothing (unique key) and
 *    deletes nothing more. Retention runs here and only here — never on a
 *    read (FR-19).
 */
@Injectable()
export class FleetNodeHealthService {
    private readonly logger = new Logger(FleetNodeHealthService.name);
    private readonly lastDropLogAt = new Map<string, number>();

    constructor(private readonly samples: FleetNodeHealthSampleRepository) {}

    /** Is the history switched on for this deployment? */
    isHistoryEnabled(): boolean {
        return config.fleet.isHealthHistoryEnabled();
    }

    /**
     * Should the beat received at `now` be written to the history? Only with
     * the flag on, and only when the last sampled beat (the row's
     * `sampledAt`) is at least 55 s old — or there is none.
     */
    shouldSample(
        previous: Pick<FleetNodeHealthStored, 'sampledAt'> | null | undefined,
        now: Date,
    ): boolean {
        if (!this.isHistoryEnabled()) return false;
        const last = previous?.sampledAt ? Date.parse(previous.sampledAt) : Number.NaN;
        if (!Number.isFinite(last)) return true;
        return now.getTime() - last >= FLEET_HEALTH_SAMPLE_MIN_INTERVAL_MS;
    }

    /**
     * Write one raw sample, fire-and-forget. Never throws and never returns a
     * promise the caller could await by mistake: the heartbeat must not wait
     * on, or fail because of, the history.
     */
    record(nodeId: string, at: Date, snapshot: FleetNodeHealthSnapshot): void {
        let pending: Promise<void>;
        try {
            pending = this.samples.insertRaw(nodeId, at, snapshot);
        } catch (error) {
            this.logDrop(nodeId, error, at);
            return;
        }
        pending.catch((error: unknown) => this.logDrop(nodeId, error, at));
    }

    /** The hourly roll-up and the retention sweep. See the class comment. */
    async rollupAndPrune(now: Date = new Date()): Promise<FleetHealthRollupSummary> {
        const nowMs = now.getTime();
        if (!this.isHistoryEnabled()) {
            // Nothing is written or rolled with the history off — but rows from
            // before it was switched off still age out: switching history off
            // must never mean keeping what it held forever.
            const { prunedRaw, prunedHourly } = await this.prune(nowMs);
            return { enabled: false, rolledHours: 0, hourlyRows: 0, prunedRaw, prunedHourly };
        }
        // The newest hour that has certainly ENDED, and the oldest whose raw
        // rows the retention below has not yet removed.
        const newestEnd = hourStart(nowMs - FLEET_HEALTH_ROLLUP_SETTLE_MS).getTime();
        const oldestStart = hourStart(nowMs - FLEET_HEALTH_RAW_RETENTION_MS).getTime() + HOUR_MS;

        let rolledHours = 0;
        let hourlyRows = 0;
        let rollError: unknown = null;
        try {
            // Oldest first: an hour about to lose its raw rows to retention is
            // rolled before a recent one, which the next pass can still reach.
            for (let start = oldestStart; start + HOUR_MS <= newestEnd; start += HOUR_MS) {
                if (rolledHours >= FLEET_HEALTH_ROLLUP_MAX_HOURS_PER_RUN) break;
                const hour = new Date(start);
                if (await this.samples.hasHourly(hour)) continue;
                const raws = await this.samples.rawInHour(hour);
                if (raws.length === 0) continue;
                const rows = rollUpByNode(hour, raws);
                await this.samples.insertHourly(rows);
                rolledHours += 1;
                hourlyRows += rows.length;
            }
        } catch (error) {
            // Retention still runs: a roll-up that fails on every pass must not
            // also let the raw table grow without bound. The failure is then
            // re-thrown, so the run is marked failed and someone looks.
            rollError = error;
        }

        // Retention AFTER the roll-up, so a raw hour that CAN be rolled is
        // rolled before it is pruned.
        const { prunedRaw, prunedHourly } = await this.prune(nowMs);
        if (rollError !== null) throw rollError;
        return { enabled: true, rolledHours, hourlyRows, prunedRaw, prunedHourly };
    }

    /** Retention: raw rows past 7 days, hourly rows past 90 days. Idempotent. */
    private async prune(nowMs: number): Promise<{ prunedRaw: number; prunedHourly: number }> {
        const prunedRaw = await this.samples.deleteBefore(
            'raw',
            new Date(nowMs - FLEET_HEALTH_RAW_RETENTION_MS),
        );
        const prunedHourly = await this.samples.deleteBefore(
            'hourly',
            new Date(nowMs - FLEET_HEALTH_HOURLY_RETENTION_MS),
        );
        return { prunedRaw, prunedHourly };
    }

    private logDrop(nodeId: string, error: unknown, at: Date): void {
        const now = at.getTime();
        const last = this.lastDropLogAt.get(nodeId);
        if (last !== undefined && now - last < FLEET_HEALTH_DROP_LOG_INTERVAL_MS) return;
        this.lastDropLogAt.set(nodeId, now);
        // The error's MESSAGE only — never the snapshot, which is the machine's.
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
            `Dropped a health sample for node ${nodeId} (logged once an hour per node): ${message}`,
        );
    }
}

/** One hourly row per node present in the hour's raw rows. */
export function rollUpByNode(
    hour: Date,
    raws: readonly FleetNodeHealthSample[],
): FleetNodeHealthHourlyRow[] {
    const byNode = new Map<string, FleetNodeHealthSample[]>();
    for (const row of raws) {
        const list = byNode.get(row.nodeId) ?? [];
        list.push(row);
        byNode.set(row.nodeId, list);
    }
    return [...byNode.entries()].map(([nodeId, rows]) => rollUpHour(nodeId, hour, rows));
}
