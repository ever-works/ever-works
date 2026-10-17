import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AppLicenseService } from '@ever-works/agent/app-license';
import { DistributedTaskLockService } from '@ever-works/agent/cache';
import { config } from '@ever-works/agent/config';
import { APPS_CATALOG_REFRESH_CRON } from '@ever-works/contracts';

/**
 * APW-03 T43 (second half) — the licence registry-change fan-out (ACC-03-22).
 *
 * Every tick re-classifies at most 500 App Works whose stored classification was made
 * against a different registry than the one in force (`findStaleRegistry`), oldest
 * first; the next tick continues where this one stopped. It runs on the Apps-catalog
 * refresh schedule (`APPS_CATALOG_REFRESH_CRON`, `23 * * * *`) in every API replica:
 * the licence write is guarded by `licenseEvaluatedSeq`, so two replicas re-classifying
 * the same Work write the same answer once each and never regress it. App Works off ⇒
 * no database read at all. The log line is counters only.
 */
/** The lease one tick holds, so only one API replica fans out at a time. */
export const APP_LICENSE_REGISTRY_FANOUT_LOCK_KEY = 'app-license:registry-fanout';

@Injectable()
export class AppLicenseRegistryCronService {
    private readonly logger = new Logger(AppLicenseRegistryCronService.name);

    constructor(
        @Optional() private readonly licenses?: AppLicenseService,
        // One replica per tick: the fan-out makes provider reads before the guarded write,
        // so overlapping replicas would multiply them. Absent (a bare spec), it runs unlocked.
        @Optional() private readonly locks?: DistributedTaskLockService,
    ) {}

    @Cron(APPS_CATALOG_REFRESH_CRON)
    async runRegistryFanOut(): Promise<{ scanned: number; evaluated: number } | null> {
        if (!this.licenses || !config.everWorks.apps.worksEnabled()) {
            return null;
        }
        try {
            const licenses = this.licenses;
            let summary: { scanned: number; evaluated: number };
            if (this.locks) {
                const run = await this.locks.runExclusive(
                    APP_LICENSE_REGISTRY_FANOUT_LOCK_KEY,
                    () => licenses.refreshStaleRegistry(),
                    { ttlMs: 10 * 60_000 },
                );
                if (!run.acquired || !run.result) {
                    return null;
                }
                summary = run.result;
            } else {
                summary = await licenses.refreshStaleRegistry();
            }
            if (summary.scanned > 0) {
                this.logger.log(
                    `app-license registry fan-out: ${summary.evaluated}/${summary.scanned} work(s) re-classified`,
                );
            }
            return summary;
        } catch (error) {
            this.logger.error(
                'app-license registry fan-out failed',
                error instanceof Error ? error.stack : String(error),
            );
            return null;
        }
    }
}
