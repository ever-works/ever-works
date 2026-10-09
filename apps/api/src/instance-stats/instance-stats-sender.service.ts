import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { CONSTANTS, STATS_RETRY_DELAYS_S } from '@ever-co/connect-sdk';
import type { StatsSendResult } from '@ever-works/contracts';
import type { EverStatsLease } from '@ever-works/agent/entities';
import {
    EverInstanceKeyUnreadableError,
    EverInstanceService,
} from '@ever-works/agent/ever-instance';
import { StatsSinkFacadeService, StatsSinkUnavailableError } from '@ever-works/agent/facades';
import { getBuildInfo } from '../health/build-info';
import {
    InstanceStatsBuildError,
    InstanceStatsBuilderService,
} from './instance-stats-builder.service';
import { InstanceStatsLeaseService } from './instance-stats-lease.service';
import {
    INSTANCE_STATS_MODULE_VERSION,
    periodOf,
    previousPeriodOf,
    versionAndChannel,
} from './instance-stats.mapping';
import { InstanceStatsSigner } from './instance-stats-signer';
import {
    INSTANCE_STATS_CLOCK,
    INSTANCE_STATS_CONFIG,
    INSTANCE_STATS_RANDOM,
    type InstanceStatsClock,
    type InstanceStatsRandom,
    type InstanceStatsRuntimeConfig,
} from './instance-stats.tokens';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The retry ladder after a `failed` send: +1 h, +4 h, +12 h (the contract's
 * `STATS_RETRY_DELAYS_S`), then the next day's slot.
 */
export const INSTANCE_STATS_RETRY_LADDER_MS: readonly number[] = STATS_RETRY_DELAYS_S.filter(
    (delayS) => delayS < DAY_MS / 1000,
).map((delayS) => delayS * 1000);
/** A first boot that is overdue by more than a day sends 10 minutes after boot. */
export const INSTANCE_STATS_OVERDUE_DELAY_MS = 10 * 60 * 1000;
/**
 * A refusal other than `422` (schema) or `409` (key) — a redirect, `401`,
 * `403`, `404`, … — parks the module for this long, then it tries again. Such
 * an answer says more about the endpoint than about the report (for example an
 * ingest not open yet), so it must not silence an installation for good.
 */
export const INSTANCE_STATS_REJECTED_RETRY_MS = 7 * DAY_MS;
/** *Send now* is allowed once per 10 minutes. */
export const INSTANCE_STATS_SEND_NOW_INTERVAL_MS = 10 * 60 * 1000;
/** Upper bound of one delivery (the contract's write timeout). */
export const INSTANCE_STATS_SEND_TIMEOUT_MS: number = CONSTANTS.timeouts_ms.write;

/**
 * Why a run sent nothing. `env`: `EVER_STATS_ENABLED` switches the module off
 * (it should not even be loaded then; the sender refuses all the same).
 */
export type InstanceStatsSkipReason = 'env' | 'ui' | 'not_due' | 'parked' | 'lease_busy';

export type InstanceStatsRunOutcome =
    | { ran: false; reason: InstanceStatsSkipReason }
    | { ran: true; results: StatsSendResult[] };

/**
 * One send of the anonymous usage statistics module: lease → build → sign →
 * hand to the `stats-sink` provider → store the exact payload → schedule the
 * next one.
 *
 * - **Operator switch first.** With the switch in Settings off, a run returns
 *   before the lease, the build or any request.
 * - **One replica.** The compare-and-set lease and the shared `nextSendAt`
 *   make N replicas send one report; the winner re-reads the schedule under
 *   the lease, so a replica that lost the race by a second sends nothing.
 * - **Schedule.** Once per UTC day at a second drawn at random for each report
 *   (never derived from the instance id), the first one a day after first
 *   boot. Days 1-3 of a month also deliver the closed previous month once
 *   (`final: true`). `failed` retries at +1 h, +4 h, +12 h, then the next day.
 *   A report refused by the schema (`422`) or for its key (`409`) is not
 *   retried until a release changes the product or the statistics module
 *   version (or, for `409`, the identity is reset); any other refusal is
 *   retried after {@link INSTANCE_STATS_REJECTED_RETRY_MS} (7 days).
 * - **No request when the sink cannot take it** (plugin missing, unusable
 *   base URL): the attempt is stored as `failed` and the ladder applies.
 */
@Injectable()
export class InstanceStatsSenderService {
    private readonly logger = new Logger(InstanceStatsSenderService.name);

    constructor(
        private readonly identity: EverInstanceService,
        private readonly builder: InstanceStatsBuilderService,
        private readonly signer: InstanceStatsSigner,
        private readonly lease: InstanceStatsLeaseService,
        private readonly sink: StatsSinkFacadeService,
        @Inject(INSTANCE_STATS_CONFIG) private readonly config: InstanceStatsRuntimeConfig,
        @Inject(INSTANCE_STATS_CLOCK) private readonly clock: InstanceStatsClock,
        @Inject(INSTANCE_STATS_RANDOM) private readonly random: InstanceStatsRandom,
    ) {}

    /**
     * Boot: create the identity and the schedule if missing. A first send is a
     * day (the send interval) after first boot; an installation that was down
     * so long its send is overdue by more than a day sends 10 minutes after boot.
     */
    async initialise(): Promise<EverStatsLease> {
        if (!this.config.enabled) throw new Error('ever-stats: switched off by EVER_STATS_ENABLED');
        const now = this.clock();
        const instance = await this.identity.ensure();
        // A key stored before PLUGIN_SECRET_ENCRYPTION_KEY was set is wrapped now;
        // without that key it stays unencrypted, which the operator must know.
        if (!(await this.identity.wrapStoredKey())) {
            this.logger.warn(
                'ever-stats: key_stored_unencrypted (set PLUGIN_SECRET_ENCRYPTION_KEY)',
            );
        }
        const firstSendAt = new Date(
            instance.createdAt.getTime() + this.config.sendIntervalS * 1000,
        );
        const schedule = await this.lease.ensureSchedule(
            firstSendAt.getTime() < now.getTime() - DAY_MS
                ? new Date(now.getTime() + INSTANCE_STATS_OVERDUE_DELAY_MS)
                : firstSendAt,
        );
        const next = schedule.nextSendAt;
        if (next && next.getTime() < now.getTime() - DAY_MS) {
            const nextSendAt = new Date(now.getTime() + INSTANCE_STATS_OVERDUE_DELAY_MS);
            await this.lease.updateSchedule({ nextSendAt });
            return { ...schedule, nextSendAt };
        }
        return schedule;
    }

    /** The scheduled path: send when due, and only then. */
    async runDue(): Promise<InstanceStatsRunOutcome> {
        if (!this.config.enabled) return { ran: false, reason: 'env' };
        const instance = await this.identity.ensure();
        if (!instance.statsEnabledUi) return { ran: false, reason: 'ui' };

        const now = this.clock();
        const schedule = await this.lease.schedule();
        if (!this.isDue(schedule, now)) return { ran: false, reason: 'not_due' };
        if (this.isParked(schedule)) {
            await this.lease.updateSchedule({ nextSendAt: this.nextSlot(now) });
            return { ran: false, reason: 'parked' };
        }

        if (!(await this.lease.tryAcquire(now))) return { ran: false, reason: 'lease_busy' };
        try {
            // Re-read under the lease: another replica may have just sent.
            const current = await this.lease.schedule();
            if (!this.isDue(current, now)) return { ran: false, reason: 'not_due' };
            return { ran: true, results: await this.sendReports(now, current) };
        } finally {
            await this.lease.release();
        }
    }

    /**
     * *Send now* — the operator's manual send. The caller has checked the
     * switch and the 10-minute rate limit; the lease still applies.
     */
    async sendNow(): Promise<InstanceStatsRunOutcome> {
        if (!this.config.enabled) return { ran: false, reason: 'env' };
        const now = this.clock();
        if (!(await this.lease.tryAcquire(now))) return { ran: false, reason: 'lease_busy' };
        try {
            // Stamped only once this replica holds the lease: a refused (busy)
            // *Send now* does not use up the operator's 10-minute window.
            await this.lease.updateSchedule({ lastManualSendAt: now });
            const current = await this.lease.schedule();
            return { ran: true, results: await this.sendReports(now, current) };
        } finally {
            await this.lease.release();
        }
    }

    /** After an identity reset a refused report may be retried at once. */
    async clearPark(): Promise<void> {
        await this.lease.updateSchedule({ rejectedModuleVersion: null, failures: 0 });
    }

    /** The `User-Agent` of a delivery: this module and the product version, nothing else. */
    userAgent(): string {
        const { version } = versionAndChannel(getBuildInfo().version);
        return `ever-stats/${INSTANCE_STATS_MODULE_VERSION} (works/${version})`;
    }

    private async sendReports(
        now: Date,
        schedule: EverStatsLease | null,
    ): Promise<StatsSendResult[]> {
        const results: StatsSendResult[] = [];
        const attempt = (schedule?.failures ?? 0) + 1;

        const main = await this.sendOne(periodOf(now), false, now, attempt);
        results.push(main);

        // Days 1-3: deliver the closed previous month once.
        if (now.getUTCDate() <= 3) {
            const previous = previousPeriodOf(now);
            if (!(await this.lease.finalSent(previous))) {
                results.push(await this.sendOne(previous, true, now, 1));
            }
        }

        await this.scheduleAfter(main, now, schedule);
        return results;
    }

    private async sendOne(
        period: string,
        final: boolean,
        now: Date,
        attempt: number,
    ): Promise<StatsSendResult> {
        let report;
        let signed;
        try {
            report = await this.builder.build(period, final, now);
            signed = await this.signer.sign(report);
        } catch (error) {
            if (error instanceof InstanceStatsBuildError) {
                // A report the schema refuses is never sent: machine tokens only.
                this.logger.error(`ever-stats: build_failed ${error.message}`);
                return { status: 'failed', httpStatus: null, errorCode: 'build_failed' };
            }
            if (error instanceof EverInstanceKeyUnreadableError) {
                // Nothing can be signed: the retry ladder applies (not a log line
                // every tick) until the key comes back or the identity is reset.
                this.logger.error(
                    'ever-stats: key_unreadable (restore PLUGIN_SECRET_ENCRYPTION_KEY or reset the identity)',
                );
                return { status: 'failed', httpStatus: null, errorCode: 'key_unreadable' };
            }
            throw error;
        }

        let result: StatsSendResult;
        if (!this.config.apiBaseUrlUsable) {
            result = { status: 'failed', httpStatus: null, errorCode: 'invalid_url' };
        } else {
            try {
                result = await this.sink.send(this.config.sinkPluginId, signed, {
                    baseUrl: this.config.apiBaseUrl,
                    timeoutMs: INSTANCE_STATS_SEND_TIMEOUT_MS,
                    userAgent: this.userAgent(),
                });
            } catch (error) {
                if (!(error instanceof StatsSinkUnavailableError)) throw error;
                result = { status: 'failed', httpStatus: null, errorCode: 'sink_unavailable' };
            }
        }

        await this.lease.recordAttempt({
            reportId: signed.reportId,
            period,
            final,
            payload: Buffer.from(signed.body).toString('utf8'),
            bytes: signed.body.byteLength,
            status: result.status,
            httpStatus: result.httpStatus,
            errorCode: result.errorCode,
            errors: result.errors && result.errors.length > 0 ? result.errors : null,
            attempt,
            moduleVersion: INSTANCE_STATS_MODULE_VERSION,
            attemptedAt: now,
        });
        this.logger.log(
            `ever-stats: report ${result.status}${result.errorCode ? ` (${result.errorCode})` : ''}${
                result.httpStatus ? ` http ${result.httpStatus}` : ''
            } period ${period}${final ? ' final' : ''}`,
        );
        return result;
    }

    private async scheduleAfter(
        result: StatsSendResult,
        now: Date,
        schedule: EverStatsLease | null,
    ): Promise<void> {
        if (result.status === 'failed') {
            const failures = (schedule?.failures ?? 0) + 1;
            const step = INSTANCE_STATS_RETRY_LADDER_MS[failures - 1];
            // A longer `Retry-After` from the receiver wins over the ladder.
            const asked = (result.retryAfterS ?? 0) * 1000;
            await this.lease.updateSchedule({
                failures,
                nextSendAt:
                    step !== undefined
                        ? new Date(now.getTime() + Math.max(step, asked))
                        : this.nextSlot(now),
            });
            return;
        }
        if (result.status === 'rejected' && !parksUntilRelease(result)) {
            // Bounded: a redirect or an access refusal is tried again after 7
            // days at the earliest (the daily slot of the day after that).
            await this.lease.updateSchedule({
                failures: 0,
                nextSendAt: this.nextSlot(
                    new Date(now.getTime() + INSTANCE_STATS_REJECTED_RETRY_MS),
                ),
                rejectedModuleVersion: null,
            });
            return;
        }
        await this.lease.updateSchedule({
            failures: 0,
            nextSendAt: this.nextSlot(now),
            rejectedModuleVersion: result.status === 'rejected' ? this.releaseMarker() : null,
        });
    }

    private isDue(schedule: EverStatsLease | null, now: Date): boolean {
        return !!schedule?.nextSendAt && schedule.nextSendAt.getTime() <= now.getTime();
    }

    private isParked(schedule: EverStatsLease | null): boolean {
        return schedule?.rejectedModuleVersion === this.releaseMarker();
    }

    /**
     * The release a `422`/`409` refusal is pinned to: the statistics module
     * version AND the product version, so the next Works release (or a new
     * module version) tries again. Stored in `rejectedModuleVersion`.
     */
    releaseMarker(): string {
        return instanceStatsReleaseMarker(versionAndChannel(getBuildInfo().version).version);
    }

    /**
     * The next send: a second drawn uniformly at random in the UTC day after
     * `now` (for a daily interval; a longer one moves that day further out),
     * or — with a test interval below a day — simply `now + interval`.
     */
    nextSlot(now: Date): Date {
        if (this.config.sendIntervalS < 86_400) {
            return new Date(now.getTime() + this.config.sendIntervalS * 1000);
        }
        const from = new Date(now.getTime() + (this.config.sendIntervalS - 86_400) * 1000);
        const nextDay = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1);
        return new Date(nextDay + this.random(86_400) * 1000);
    }
}

/**
 * `422` (the schema refused the report) and `409` (another key holds the
 * instance id) repeat for as long as the same code sends the same report, so
 * they park until the release changes. Every other refusal is bounded.
 */
function parksUntilRelease(result: StatsSendResult): boolean {
    return result.httpStatus === 422 || result.httpStatus === 409;
}

/**
 * A 14-character token for (statistics module version, product version) —
 * the width of the `rejectedModuleVersion` column. A marker written by an
 * earlier release (or the bare module version an older build stored) never
 * matches, so an upgrade always un-parks.
 */
export function instanceStatsReleaseMarker(productVersion: string): string {
    return createHash('sha256')
        .update(`${INSTANCE_STATS_MODULE_VERSION}|${productVersion}`)
        .digest('hex')
        .slice(0, 14);
}
