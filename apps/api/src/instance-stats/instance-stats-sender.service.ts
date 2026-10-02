import { Inject, Injectable, Logger } from '@nestjs/common';
import type { StatsSendResult } from '@ever-works/contracts';
import type { EverStatsLease } from '@ever-works/agent/entities';
import { EverInstanceService } from '@ever-works/agent/ever-instance';
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

/** The retry ladder after a `failed` send: +1 h, +4 h, +12 h, then the next day's slot. */
export const INSTANCE_STATS_RETRY_LADDER_MS = [HOUR_MS, 4 * HOUR_MS, 12 * HOUR_MS] as const;
/** A first boot that is overdue by more than a day sends 10 minutes after boot. */
export const INSTANCE_STATS_OVERDUE_DELAY_MS = 10 * 60 * 1000;
/** *Send now* is allowed once per 10 minutes. */
export const INSTANCE_STATS_SEND_NOW_INTERVAL_MS = 10 * 60 * 1000;
/** Upper bound of one delivery. */
export const INSTANCE_STATS_SEND_TIMEOUT_MS = 10_000;

/** Why a run sent nothing. */
export type InstanceStatsSkipReason = 'ui' | 'not_due' | 'parked' | 'lease_busy';

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
 *   (`final: true`). `failed` retries at +1 h, +4 h, +12 h, then the next day;
 *   `rejected` is not retried until the module version changes or the
 *   identity is reset.
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
        const now = this.clock();
        const instance = await this.identity.ensure();
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
        const now = this.clock();
        await this.lease.updateSchedule({ lastManualSendAt: now });
        if (!(await this.lease.tryAcquire(now))) return { ran: false, reason: 'lease_busy' };
        try {
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
            await this.lease.updateSchedule({
                failures,
                nextSendAt:
                    step !== undefined ? new Date(now.getTime() + step) : this.nextSlot(now),
            });
            return;
        }
        await this.lease.updateSchedule({
            failures: 0,
            nextSendAt: this.nextSlot(now),
            rejectedModuleVersion:
                result.status === 'rejected' ? INSTANCE_STATS_MODULE_VERSION : null,
        });
    }

    private isDue(schedule: EverStatsLease | null, now: Date): boolean {
        return !!schedule?.nextSendAt && schedule.nextSendAt.getTime() <= now.getTime();
    }

    private isParked(schedule: EverStatsLease | null): boolean {
        return schedule?.rejectedModuleVersion === INSTANCE_STATS_MODULE_VERSION;
    }

    /**
     * The next send: a second drawn uniformly at random in the next UTC day, or
     * — with a test interval — simply `now + interval`.
     */
    nextSlot(now: Date): Date {
        if (this.config.sendIntervalS !== 86_400) {
            return new Date(now.getTime() + this.config.sendIntervalS * 1000);
        }
        const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
        return new Date(tomorrow + this.random(86_400) * 1000);
    }
}
