import type { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';

/**
 * Lane aw-ops (APW-06, 2026-10-27) — the Activity row of a member asking the isolated worker to
 * change something on a live App: **Run now** on a job (FR-51) and **Run smoke checks**
 * (FR-36/FR-37). The worker's own `app.job.succeeded|failed` / `app.smoke.passed|failed` rows
 * follow when the run ends (through the event relay); this one records who asked, and when.
 *
 * Not written for a status refresh or a log fetch: neither changes the App, and FR-48 keeps logs
 * out of Activity altogether.
 *
 * `metadata` is a job name, a request id and whether the worker took it — never a value, a log
 * line or a host (every Activity row reaches the analytics sink). Fire-and-forget like
 * `recordAppDependencyActivity`: the request already happened, and a log store that is down must
 * not turn it into a 500.
 */
export interface AppOpsActivityEntry {
    userId: string;
    workId: string;
    action: 'app.job.requested' | 'app.smoke.requested';
    summary: string;
    details?: Record<string, string | number | boolean | null>;
}

export function recordAppOpsActivity(
    log: Pick<ActivityLogService, 'log'> | undefined,
    entry: AppOpsActivityEntry,
): void {
    if (!log?.log) return;
    try {
        void log
            .log({
                userId: entry.userId,
                workId: entry.workId,
                actionType:
                    entry.action === 'app.job.requested'
                        ? ActivityActionType.APP_JOB
                        : ActivityActionType.APP_SMOKE,
                action: entry.action,
                status: ActivityStatus.PENDING,
                summary: entry.summary,
                metadata: { ...(entry.details ?? {}) },
            })
            .catch(() => undefined);
    } catch {
        // A synchronous throw from a double or a half-bound service is still not the caller's 500.
    }
}
