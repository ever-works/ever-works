import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    APP_BUILD_RUN_DISCOVERY_BATCH,
    APP_BUILD_RUN_DISCOVERY_PER_PAGE,
    type BuildRunRef,
} from '@ever-works/contracts';

import { AppBuildPreparationRepository } from '../database/repositories/app-build-preparation.repository';
import {
    APP_BUILD_PLUGIN_RESOLVER,
    APP_BUILD_WORK_SOURCE,
    AppBuildsService,
    type AppBuildPluginBinding,
    type AppBuildPluginResolver,
    type AppBuildWorkSource,
} from './app-builds.service';

/**
 * APW-05 T21a — run discovery: Builds without a delivery (plan §7.4a,
 * `APW05-G01`, `GAP-07`).
 *
 * A push or a pull-request run must become a Build whether or not a
 * `workflow_run` delivery reaches the platform: a personal fork connected
 * through OAuth has no App installation, so no delivery ever comes. Once per
 * sweep tick, before the silent pass:
 *
 *  1. **Scope** — up to {@link APP_BUILD_RUN_DISCOVERY_BATCH} App Works whose
 *     workflow is written (`workflowSha256` set), stalest `runsCheckedAt` first.
 *  2. **Read** — the binding's `listRecentRuns` with the stored `runsEtag`. A
 *     provider without it is skipped; `notModified` only stamps `runsCheckedAt`.
 *  3. **Record** — every run created at or after `workflowWrittenAt` goes to
 *     `AppBuildsService.recordProviderRun(workId, run, 'poll')`, the SAME entry
 *     point the webhook consumer uses, so the accept rules (strategy gate, fork
 *     rule, manual adoption) live in one place and a delivery plus a poll of one
 *     run converge on one row and one `app.build.queued`.
 *  4. **Cursor** — `runsEtag` and `runsCheckedAt` on the preparation row (§3.1b).
 *
 * ## Re-recording is bounded
 *
 * A `completed` run created before the previous check (minus a margin) was
 * already offered on an earlier tick; offering it again would dispatch a watch
 * for a Build that is long settled, up to 20 per Work per tick. Such a run is
 * skipped — a Build still open for it is the silent pass's to observe.
 *
 * Every per-Work failure is counted and logged and never stops the pass, and a
 * discovery failure never stops the silent pass that follows it (the sweep
 * catches it).
 */

/** How far before the previous check a completed run is still offered (clock skew, a slow tick). */
export const APP_BUILD_DISCOVERY_RECHECK_MARGIN_MS = 5 * 60_000;

/** The discovery half of the facade's binding. */
export interface AppBuildDiscoveryPluginBinding extends AppBuildPluginBinding {
    listRecentRuns?(input: {
        readonly perPage: number;
        readonly etag?: string;
    }): Promise<{ notModified: boolean; etag?: string; runs: BuildRunRef[] }>;
}

/** One discovery pass's counters (no ids, no names). */
export interface AppBuildRunDiscoverySummary {
    readonly worksChecked: number;
    readonly worksNotModified: number;
    readonly worksSkipped: number;
    readonly worksFailed: number;
    readonly runsSeen: number;
    readonly runsRecorded: number;
    readonly buildsCreated: number;
}

@Injectable()
export class AppBuildRunDiscoveryService {
    private readonly logger = new Logger(AppBuildRunDiscoveryService.name);

    constructor(
        private readonly preparations: AppBuildPreparationRepository,
        private readonly builds: AppBuildsService,
        @Optional()
        @Inject(APP_BUILD_WORK_SOURCE)
        private readonly works?: AppBuildWorkSource,
        @Optional()
        @Inject(APP_BUILD_PLUGIN_RESOLVER)
        private readonly plugins?: AppBuildPluginResolver,
    ) {}

    async discover(nowMs: number = Date.now()): Promise<AppBuildRunDiscoverySummary> {
        const summary = {
            worksChecked: 0,
            worksNotModified: 0,
            worksSkipped: 0,
            worksFailed: 0,
            runsSeen: 0,
            runsRecorded: 0,
            buildsCreated: 0,
        };
        if (!this.works || !this.plugins) {
            return summary;
        }

        const candidates = await this.preparations.findDiscoveryCandidates(
            APP_BUILD_RUN_DISCOVERY_BATCH,
        );
        for (const row of candidates) {
            summary.worksChecked += 1;
            try {
                const context = await this.works.read(row.workId);
                if (!context) {
                    summary.worksSkipped += 1;
                    continue;
                }
                const binding = (await this.plugins.resolve(
                    row.workId,
                    context.userId,
                )) as AppBuildDiscoveryPluginBinding | null;
                if (!binding?.listRecentRuns) {
                    summary.worksSkipped += 1;
                    continue;
                }

                const page = await binding.listRecentRuns({
                    perPage: APP_BUILD_RUN_DISCOVERY_PER_PAGE,
                    ...(row.runsEtag ? { etag: row.runsEtag } : {}),
                });
                const checkedAt = new Date(nowMs);
                if (page.notModified) {
                    summary.worksNotModified += 1;
                    await this.preparations.upsertAfterPrepare(row.workId, {
                        runsCheckedAt: checkedAt,
                    });
                    continue;
                }

                const writtenAtMs = row.workflowWrittenAt?.getTime() ?? 0;
                const previousCheckMs = row.runsCheckedAt?.getTime() ?? null;
                for (const run of page.runs) {
                    summary.runsSeen += 1;
                    const createdMs = Date.parse(run.createdAt);
                    if (Number.isFinite(createdMs) && createdMs < writtenAtMs) continue;
                    if (
                        run.status === 'completed' &&
                        previousCheckMs !== null &&
                        Number.isFinite(createdMs) &&
                        createdMs < previousCheckMs - APP_BUILD_DISCOVERY_RECHECK_MARGIN_MS
                    ) {
                        continue;
                    }
                    const recorded = await this.builds.recordProviderRun(row.workId, run, 'poll');
                    if (recorded.accepted) {
                        summary.runsRecorded += 1;
                        if (recorded.created) summary.buildsCreated += 1;
                    }
                }

                await this.preparations.upsertAfterPrepare(row.workId, {
                    runsCheckedAt: checkedAt,
                    ...(page.etag ? { runsEtag: page.etag } : {}),
                });
            } catch (error) {
                summary.worksFailed += 1;
                this.logger.warn(
                    `App builds: run discovery for work ${row.workId} failed (${
                        error instanceof Error ? error.message : String(error)
                    }).`,
                );
            }
        }
        return summary;
    }
}
