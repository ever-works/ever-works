import type { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';

/**
 * Lane aw-deps-api (APW-07, 2026-10-18) — the one Activity writer of an owner's action on an App
 * Work's dependencies: the Dependencies card's Configure / Retry / Delete data routes
 * (`WorkAppDependenciesController`) and the Deploy request that retried transient failures
 * (`WorkAppDeployController`).
 *
 * `metadata` is kinds, a provider id, a trigger and counts — never a config value, an output or a
 * connection string (FR-5, plan §9.1:928-936: every Activity row reaches the analytics sink).
 *
 * Fire-and-forget like every other route-side Activity write (`bulk-items.controller.ts`): the
 * action already happened, and a log store that is down must not turn it into a 500.
 */
export interface AppDependencyActivityEntry {
    userId: string;
    workId: string;
    /** The dotted event, e.g. `app.dependency.retried` (Resolution R-2). */
    action:
        | 'app.dependency.configured'
        | 'app.dependency.retried'
        | 'app.dependency.data_delete_requested';
    summary: string;
    kinds: readonly string[];
    /** Optional, non-secret extras: `providerId`, `trigger`, `dispatched`, `sizeGiB`. */
    details?: Record<string, string | number | boolean | null>;
}

export function recordAppDependencyActivity(
    log: Pick<ActivityLogService, 'log'> | undefined,
    entry: AppDependencyActivityEntry,
): void {
    if (!log?.log) return;
    try {
        void log
            .log({
                userId: entry.userId,
                workId: entry.workId,
                actionType: ActivityActionType.APP_DEPENDENCY,
                action: entry.action,
                status: ActivityStatus.COMPLETED,
                summary: entry.summary,
                metadata: { kinds: [...entry.kinds], ...(entry.details ?? {}) },
            })
            .catch(() => undefined);
    } catch {
        // A synchronous throw from a double or a half-bound service is still not the caller's 500.
    }
}
