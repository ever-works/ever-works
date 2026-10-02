import type { DataSource } from 'typeorm';
import type { SignedStatsReport, StatsSendResult } from '@ever-works/contracts';
import type { StatsSinkSendOptions } from '@ever-works/plugin';
import { EverInstance, EverStatsLease, EverStatsReport } from '@ever-works/agent/entities';
import {
    EverInstanceService,
    InstanceStatsRepository,
    readEverStatsConfig,
    type EverStatsConfig,
} from '@ever-works/agent/ever-instance';
import type { StatsSinkFacadeService } from '@ever-works/agent/facades';
import { PluginSecretEncService } from '@ever-works/agent/plugins';
import { InstanceStatsBuilderService } from '../../instance-stats-builder.service';
import { InstanceStatsLeaseService } from '../../instance-stats-lease.service';
import { InstanceStatsSenderService } from '../../instance-stats-sender.service';
import { InstanceStatsSigner } from '../../instance-stats-signer';
import { InstanceStatsService } from '../../instance-stats.service';

/** One delivery the fake sink saw. */
export interface SinkCall {
    pluginId: string;
    report: SignedStatsReport;
    options: StatsSinkSendOptions;
}

/**
 * A stand-in for the `stats-sink` facade: records every report handed to it
 * and answers with `answer` (or throws `unavailable`).
 */
export class FakeSink {
    readonly calls: SinkCall[] = [];
    answer: StatsSendResult | ((call: SinkCall) => Promise<StatsSendResult>) = {
        status: 'sent',
        httpStatus: 202,
        errorCode: null,
    };
    available = true;

    isAvailable(): boolean {
        return this.available;
    }

    async send(
        pluginId: string,
        report: SignedStatsReport,
        options: StatsSinkSendOptions,
    ): Promise<StatsSendResult> {
        const call = { pluginId, report, options };
        this.calls.push(call);
        return typeof this.answer === 'function' ? this.answer(call) : this.answer;
    }
}

export interface StatsHarness {
    dataSource: DataSource;
    config: EverStatsConfig;
    clock: { now: Date };
    identity: EverInstanceService;
    repository: InstanceStatsRepository;
    builder: InstanceStatsBuilderService;
    signer: InstanceStatsSigner;
    lease: InstanceStatsLeaseService;
    sink: FakeSink;
    sender: InstanceStatsSenderService;
    service: InstanceStatsService;
    activity: Array<Record<string, unknown>>;
}

/**
 * The whole statistics graph wired by hand against one database — the same
 * classes the module provides, with a settable clock, a deterministic random
 * source and a recording sink. Two harnesses on ONE data source are two API
 * replicas.
 */
export function createHarness(
    dataSource: DataSource,
    options: {
        env?: Record<string, string | undefined>;
        now?: Date;
        random?: (max: number) => number;
        sink?: StatsSinkFacadeService | FakeSink;
    } = {},
): StatsHarness {
    const config = readEverStatsConfig({ NODE_ENV: 'test', ...(options.env ?? {}) });
    const clock = { now: options.now ?? new Date('2026-10-15T08:00:00.000Z') };
    const identity = new EverInstanceService(
        dataSource.getRepository(EverInstance),
        new PluginSecretEncService(),
    );
    const repository = new InstanceStatsRepository(dataSource);
    const builder = new InstanceStatsBuilderService(identity, repository, config);
    const signer = new InstanceStatsSigner(identity);
    const lease = new InstanceStatsLeaseService(
        dataSource.getRepository(EverStatsLease),
        dataSource.getRepository(EverStatsReport),
    );
    const sink = (options.sink ?? new FakeSink()) as FakeSink;
    const sender = new InstanceStatsSenderService(
        identity,
        builder,
        signer,
        lease,
        sink as unknown as StatsSinkFacadeService,
        config,
        () => clock.now,
        options.random ?? (() => 3_600),
    );
    const activity: Array<Record<string, unknown>> = [];
    const service = new InstanceStatsService(
        identity,
        builder,
        sender,
        lease,
        sink as unknown as StatsSinkFacadeService,
        config,
        () => clock.now,
        {
            log: async (entry: Record<string, unknown>) => {
                activity.push(entry);
                return entry;
            },
        } as never,
    );
    return {
        dataSource,
        config,
        clock,
        identity,
        repository,
        builder,
        signer,
        lease,
        sink,
        sender,
        service,
        activity,
    };
}
