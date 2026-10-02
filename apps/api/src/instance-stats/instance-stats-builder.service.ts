import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EVER_STATS_V1_SCHEMA_ID, type WorksStatsV1Report } from '@ever-works/contracts';
import {
    EverInstanceService,
    InstanceStatsRepository,
    validateStatsReport,
    type StatsReportValidationError,
} from '@ever-works/agent/ever-instance';
import { getBuildInfo } from '../health/build-info';
import {
    INSTANCE_STATS_MODULE_VERSION,
    foldDeploymentsByProvider,
    foldWorksByKind,
    periodRange,
    utcDateOf,
    versionAndChannel,
} from './instance-stats.mapping';
import { INSTANCE_STATS_CONFIG, type InstanceStatsRuntimeConfig } from './instance-stats.tokens';

/** The builder produced something the published schema refuses: nothing is signed or sent. */
export class InstanceStatsBuildError extends Error {
    constructor(readonly errors: StatsReportValidationError[]) {
        // Machine tokens only: the paths name schema fields, never a value.
        super(`report failed validation at ${errors.map((error) => error.path || '/').join(', ')}`);
        this.name = 'InstanceStatsBuildError';
    }
}

/**
 * Builds one `ever.stats.v1` report for Ever Works from the instance-wide
 * aggregates, the feature switches read at boot and the declared install
 * source and country — and validates it against the vendored schema before
 * returning it. A report that does not validate is never returned.
 *
 * Every instance reports full counts and aggregates, whatever its size: there
 * is no small-instance rule.
 */
@Injectable()
export class InstanceStatsBuilderService {
    constructor(
        private readonly identity: EverInstanceService,
        private readonly repository: InstanceStatsRepository,
        @Inject(INSTANCE_STATS_CONFIG) private readonly config: InstanceStatsRuntimeConfig,
    ) {}

    /**
     * @param period `YYYY-MM` — the UTC month the counters describe.
     * @param final `true` for the closed previous month (re-sent on days 1-3).
     * @param now the build time; only its UTC date is sent.
     */
    async build(period: string, final: boolean, now: Date): Promise<WorksStatsV1Report> {
        const instance = await this.identity.ensure();
        const raw = await this.repository.collect(periodRange(period));
        const { version, channel } = versionAndChannel(getBuildInfo().version);

        const report: WorksStatsV1Report = {
            schema: EVER_STATS_V1_SCHEMA_ID,
            report_id: randomUUID(),
            instance_id: instance.instanceId,
            sent_at: utcDateOf(now),
            module_version: INSTANCE_STATS_MODULE_VERSION,
            product: 'works',
            instance_kind: 'backend',
            serves: ['works'],
            version,
            channel,
            install_source: this.config.installSource,
            country: this.config.country,
            period,
            final,
            counts: {
                users: raw.users,
                tenants: raw.tenants,
                organizations: raw.organizations,
                works: raw.works,
                agents: raw.agents,
                missions: raw.missions,
                teams: raw.teams,
                fleet_nodes: raw.fleetNodes,
                plugins_enabled: raw.pluginsEnabled,
                works_by_kind: foldWorksByKind(raw.worksByKind),
            },
            features: { ...this.config.features },
            aggregates: {
                deployments: raw.deployments,
                deployments_by_provider: foldDeploymentsByProvider(raw.deploymentsByProvider),
                runs: raw.runs,
                credits_consumed: raw.creditsConsumed,
            },
        };

        const validation = validateStatsReport(report);
        // `in` narrows here whatever the compiler's null checks (this app runs without them).
        if ('errors' in validation) throw new InstanceStatsBuildError(validation.errors);
        return report;
    }
}
