import { Inject, Injectable, Optional } from '@nestjs/common';
import type {
    InstanceStatsManagedBy,
    InstanceStatsOperatorStatus,
    InstanceStatsPublicStatus,
    InstanceStatsReason,
    InstanceStatsReportView,
    WorksStatsV1Report,
} from '@ever-works/contracts';
import type { EverStatsReport } from '@ever-works/agent/entities';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { EverInstanceService } from '@ever-works/agent/ever-instance';
import { StatsSinkFacadeService } from '@ever-works/agent/facades';
import { InstanceStatsBuilderService } from './instance-stats-builder.service';
import { InstanceStatsLeaseService } from './instance-stats-lease.service';
import { periodOf } from './instance-stats.mapping';
import {
    INSTANCE_STATS_SEND_NOW_INTERVAL_MS,
    InstanceStatsSenderService,
    type InstanceStatsRunOutcome,
} from './instance-stats-sender.service';
import {
    INSTANCE_STATS_CLOCK,
    INSTANCE_STATS_CONFIG,
    type InstanceStatsClock,
    type InstanceStatsRuntimeConfig,
} from './instance-stats.tokens';

/** *Send now* refused: the switch is off, or the 10-minute limit applies. */
export class InstanceStatsSendNowRefusedError extends Error {
    constructor(
        readonly reason: 'ui' | 'rate_limited' | 'busy',
        readonly retryAfterS: number | null = null,
    ) {
        super(`send now refused: ${reason}`);
        this.name = 'InstanceStatsSendNowRefusedError';
    }
}

/** *Reset instance identity* refused: a report is being built or sent right now. */
export class InstanceStatsResetRefusedError extends Error {
    constructor() {
        super('reset refused: send in progress');
        this.name = 'InstanceStatsResetRefusedError';
    }
}

/**
 * The operator surface of the anonymous usage statistics module (Settings →
 * Ever Platform → Anonymous usage statistics): status, a live preview of what
 * would be sent, the exact last payload, *Send now*, the switch and *Reset
 * instance identity*.
 *
 * The switch and the reset each write one Activity row carrying the actor and
 * the action only — no payload, no address, no user agent.
 */
@Injectable()
export class InstanceStatsService {
    constructor(
        private readonly identity: EverInstanceService,
        private readonly builder: InstanceStatsBuilderService,
        private readonly sender: InstanceStatsSenderService,
        private readonly lease: InstanceStatsLeaseService,
        private readonly sink: StatsSinkFacadeService,
        @Inject(INSTANCE_STATS_CONFIG) private readonly config: InstanceStatsRuntimeConfig,
        @Inject(INSTANCE_STATS_CLOCK) private readonly clock: InstanceStatsClock,
        @Optional() private readonly activity?: ActivityLogService,
    ) {}

    /** What any signed-in person may know: whether statistics are on, and who manages them. */
    async publicStatus(): Promise<InstanceStatsPublicStatus> {
        const instance = await this.identity.ensure();
        return { enabled: instance.statsEnabledUi, managedBy: this.managedBy() };
    }

    /** Ever Cloud for an installation that declares itself `cloud`, the instance operator otherwise. */
    managedBy(): InstanceStatsManagedBy {
        return this.config.installSource === 'cloud' ? 'cloud' : 'operator';
    }

    async operatorStatus(): Promise<InstanceStatsOperatorStatus> {
        const instance = await this.identity.ensure();
        const [schedule, last, keyReadable] = await Promise.all([
            this.lease.schedule(),
            this.lease.lastReport(),
            this.identity.isKeyReadable(),
        ]);
        const sinkAvailable = this.sink.isAvailable(this.config.sinkPluginId);
        const reason: InstanceStatsReason = !instance.statsEnabledUi
            ? 'ui'
            : !keyReadable
              ? 'key_unreadable'
              : !sinkAvailable
                ? 'sink_unavailable'
                : this.config.installSource === 'cloud'
                  ? 'cloud-managed'
                  : 'on';
        const lastManual = schedule?.lastManualSendAt?.getTime() ?? null;
        const nextManual =
            lastManual !== null ? lastManual + INSTANCE_STATS_SEND_NOW_INTERVAL_MS : null;
        return {
            operator: true,
            enabled: instance.statsEnabledUi,
            managedBy: this.managedBy(),
            reason,
            uiEnabled: instance.statsEnabledUi,
            installSource: this.config.installSource,
            country: this.config.country,
            statsApiUrl: this.config.apiBaseUrl,
            instanceId: instance.instanceId,
            resetCount: instance.resetCount,
            nextSendAt:
                instance.statsEnabledUi && schedule?.nextSendAt
                    ? schedule.nextSendAt.toISOString()
                    : null,
            sinkAvailable,
            keyStoredEncrypted: this.identity.isKeyStoredWrapped(instance),
            lastReport: last ? withoutPayload(toView(last)) : null,
            sendNowAvailableAt:
                nextManual !== null && nextManual > this.clock().getTime()
                    ? new Date(nextManual).toISOString()
                    : null,
        };
    }

    /** *What is sent*: a report built now from live numbers — never signed, stored or sent. */
    async preview(): Promise<WorksStatsV1Report> {
        const now = this.clock();
        return this.builder.build(periodOf(now), false, now);
    }

    /** *Last payload*: the exact bytes of the newest attempt. */
    async last(): Promise<InstanceStatsReportView | null> {
        const row = await this.lease.lastReport();
        return row ? toView(row) : null;
    }

    async sendNow(actorUserId: string): Promise<InstanceStatsRunOutcome> {
        const instance = await this.identity.ensure();
        if (!instance.statsEnabledUi) throw new InstanceStatsSendNowRefusedError('ui');
        const schedule = await this.lease.schedule();
        const last = schedule?.lastManualSendAt?.getTime();
        const now = this.clock().getTime();
        if (last !== undefined && now - last < INSTANCE_STATS_SEND_NOW_INTERVAL_MS) {
            throw new InstanceStatsSendNowRefusedError(
                'rate_limited',
                Math.ceil((last + INSTANCE_STATS_SEND_NOW_INTERVAL_MS - now) / 1000),
            );
        }
        const outcome = await this.sender.sendNow();
        if (!outcome.ran) throw new InstanceStatsSendNowRefusedError('busy');
        this.audit(actorUserId, 'instance_stats.send_now', 'Sent anonymous usage statistics now');
        return outcome;
    }

    async setEnabled(actorUserId: string, enabled: boolean): Promise<boolean> {
        const instance = await this.identity.setStatsEnabledUi(enabled);
        this.audit(
            actorUserId,
            enabled ? 'instance_stats.enabled' : 'instance_stats.disabled',
            enabled
                ? 'Turned anonymous usage statistics on'
                : 'Turned anonymous usage statistics off',
        );
        return instance.statsEnabledUi;
    }

    /**
     * A new instance id and key, taken under the send lease: every send builds
     * and signs under that lease, so a report built for the OLD identity can
     * never be signed with the NEW key (one request would pair them). While a
     * send holds the lease the reset is refused (409); with no schedule row
     * yet, nothing can be sending.
     */
    async resetIdentity(actorUserId: string): Promise<{ instanceId: string; resetCount: number }> {
        const leased = (await this.lease.schedule()) !== null;
        if (leased && !(await this.lease.tryAcquire(this.clock()))) {
            throw new InstanceStatsResetRefusedError();
        }
        try {
            const instance = await this.identity.reset();
            await this.sender.clearPark();
            this.audit(
                actorUserId,
                'instance_stats.identity_reset',
                'Reset the anonymous usage statistics identity',
            );
            return { instanceId: instance.instanceId, resetCount: instance.resetCount };
        } finally {
            if (leased) await this.lease.release();
        }
    }

    /** One Activity row: actor and action, nothing else. Best-effort, never fails the request. */
    private audit(userId: string, action: string, summary: string): void {
        this.activity
            ?.log({
                userId,
                actionType: ActivityActionType.SETTINGS_UPDATED,
                action,
                status: ActivityStatus.COMPLETED,
                summary,
                metadata: {},
            })
            .catch(() => {});
    }
}

function toView(row: EverStatsReport): InstanceStatsReportView {
    return {
        reportId: row.reportId,
        period: row.period,
        final: row.final,
        status: row.status,
        httpStatus: row.httpStatus ?? null,
        errorCode: row.errorCode ?? null,
        errors: row.errors ?? [],
        attemptedAt: new Date(row.attemptedAt).toISOString(),
        bytes: row.bytes,
        payload: row.payload,
    };
}

function withoutPayload(view: InstanceStatsReportView): Omit<InstanceStatsReportView, 'payload'> {
    const { payload: _payload, ...rest } = view;
    return rest;
}
