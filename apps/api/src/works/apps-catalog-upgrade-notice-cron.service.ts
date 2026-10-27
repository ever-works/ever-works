import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppBlueprintUpgradeService } from '@ever-works/agent/app-works';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { APPS_CATALOG_REFRESH_CRON } from '@ever-works/contracts';

/**
 * APW-03 T30 (lane aw-blueprints) — the hourly "a new Blueprint version is out" pass:
 * `AppBlueprintUpgradeService.refreshUpgradeNotices()` at `APPS_CATALOG_REFRESH_CRON`
 * (`23 * * * *`, off the hour and off the :17 skill sweep — the same cadence and the
 * same shape as `AppLicenseRegistryCronService`, its licence-registry sibling).
 *
 * It sets `blueprintLatestVersion` on every App Work behind its Blueprint's newest
 * release and records `app.blueprint.upgrade_available` once per version; the App spec
 * tab's Blueprint card renders the notice from that column.
 *
 * One API replica per tick (`DistributedTaskLockService`): the pass reads Blueprint
 * repositories before its guarded writes, so overlapping replicas would multiply the
 * reads. Off while App Works are off; absent the service (a bare spec) it does nothing.
 */
export const APP_BLUEPRINT_NOTICE_LOCK_KEY = 'app-blueprint:upgrade-notices';

@Injectable()
export class AppsCatalogUpgradeNoticeCronService {
    private readonly logger = new Logger(AppsCatalogUpgradeNoticeCronService.name);

    constructor(
        @Optional() private readonly upgrades?: AppBlueprintUpgradeService,
        @Optional() private readonly locks?: DistributedTaskLockService,
    ) {}

    @Cron(APPS_CATALOG_REFRESH_CRON)
    async runUpgradeNotices(): Promise<{
        blueprints: number;
        scanned: number;
        notices: number;
    } | null> {
        if (!this.upgrades || !config.everWorks.apps.worksEnabled()) {
            return null;
        }
        try {
            const upgrades = this.upgrades;
            let summary: { blueprints: number; scanned: number; notices: number };
            if (this.locks) {
                const run = await this.locks.runExclusive(
                    APP_BLUEPRINT_NOTICE_LOCK_KEY,
                    () => upgrades.refreshUpgradeNotices(),
                    { ttlMs: 10 * 60_000 },
                );
                if (!run.acquired || !run.result) {
                    return null;
                }
                summary = run.result;
            } else {
                summary = await upgrades.refreshUpgradeNotices();
            }
            if (summary.notices > 0) {
                this.logger.log(
                    `Blueprint upgrade notices: ${summary.notices} new across ${summary.blueprints} Blueprint(s)`,
                );
            }
            return summary;
        } catch (error) {
            this.logger.warn(
                `Blueprint upgrade notices failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
        }
    }
}
