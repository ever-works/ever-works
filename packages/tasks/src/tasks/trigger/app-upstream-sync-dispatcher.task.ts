import { schedules } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import {
    APP_UPSTREAM_SYNC_DISPATCHER_SERVICE,
    TriggerInternalModule,
} from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';

/**
 * APW-02 T34 — the `app-upstream-sync-dispatcher` cron (plan §6.6, `plan.md:800-830`).
 *
 * One `schedules.task` that, every tick, calls the API-side
 * `AppUpstreamSyncDispatcherService.dispatchDue()` over the internal RPC channel
 * (`APP_UPSTREAM_SYNC_DISPATCHER_SERVICE`, a remote proxy `TriggerInternalModule` already
 * provides). That one call does the four passes of §6.6 where the rows live: claim the
 * due Fork / private-copy Works (≤ 50, stamping `nextSyncAt` BEFORE queueing each
 * `app-upstream-sync`), re-dispatch stale readiness runs, re-check unavailable upstreams
 * and follow up open setup pull requests.
 *
 * `dispatchDue()` is called with **no argument** on purpose: the service's `now` is a
 * clock seam for its specs, and the API must read its own clock.
 *
 * ## The cron is an operator override, not a switch
 *
 * `APP_UPSTREAM_SYNC_DISPATCHER_CRON` (default every 10 minutes) changes WHEN the tick
 * runs, never WHETHER sync runs — R-30's family switch (`EVER_WORKS_APP_SYNC_ENABLED`)
 * stays the only on/off control. A malformed or non-five-field value falls back to the
 * default rather than reaching Trigger.dev (the validation is copied from
 * `data-repo-sync-dispatcher.task.ts`), so the schedule always registers.
 */

/** Plan §6.6 — every ten minutes. */
export const DEFAULT_APP_UPSTREAM_SYNC_DISPATCHER_CRON = '*/10 * * * *';

const CRON_FIELD = '(?:\\*|\\*/\\d+|\\d+(?:-\\d+)?(?:/\\d+)?(?:,\\d+(?:-\\d+)?(?:/\\d+)?)*)';
const FIVE_FIELD_CRON = new RegExp(`^${CRON_FIELD}(?:\\s+${CRON_FIELD}){4}$`);

/** The env override when it is a valid five-field cron, else the default. */
export function resolveAppUpstreamSyncDispatcherCron(
    raw: string | undefined = process.env.APP_UPSTREAM_SYNC_DISPATCHER_CRON,
): string {
    if (raw === undefined) return DEFAULT_APP_UPSTREAM_SYNC_DISPATCHER_CRON;
    const trimmed = raw.trim();
    return FIVE_FIELD_CRON.test(trimmed) ? trimmed : DEFAULT_APP_UPSTREAM_SYNC_DISPATCHER_CRON;
}

const cronExpression = resolveAppUpstreamSyncDispatcherCron();

/** `AppUpstreamDispatchCounters` (agent), as this tick reads it over the proxy. */
interface AppUpstreamSyncDispatcher {
    dispatchDue: () => Promise<{
        dueCount: number;
        dispatched: number;
        redispatchedReadiness: number;
        timedOut: number;
        rechecked: number;
        setupChecked: number;
        failed: number;
        skipped: number;
    }>;
}

/** The tick body, exported so the spec (and a local drain) can run it directly. */
export async function runAppUpstreamSyncDispatcherTick(): Promise<Record<string, unknown>> {
    const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
    appContext.useLogger(createTriggerLogger('AppUpstreamSyncDispatcher'));
    let logger: { log?: (m: string) => void } = console;
    try {
        const fromCtx = appContext.get('NestFactoryStaticLogger', { strict: false });
        if (fromCtx) logger = fromCtx as typeof logger;
    } catch {
        // Fall back to console — already the default.
    }

    try {
        const dispatcher = appContext.get<AppUpstreamSyncDispatcher>(
            APP_UPSTREAM_SYNC_DISPATCHER_SERVICE,
        );
        const summary = await dispatcher.dispatchDue();

        logger.log?.(
            `App upstream sync dispatch tick — due=${summary.dueCount} dispatched=${summary.dispatched} ` +
                `readiness=${summary.redispatchedReadiness} timedOut=${summary.timedOut} ` +
                `rechecked=${summary.rechecked} setup=${summary.setupChecked} ` +
                `skipped=${summary.skipped} failed=${summary.failed}`,
        );

        return { cron: cronExpression, ...summary };
    } finally {
        await appContext.close();
    }
}

export const appUpstreamSyncDispatcherTask = schedules.task({
    id: 'app-upstream-sync-dispatcher',
    cron: cronExpression,
    run: runAppUpstreamSyncDispatcherTick,
});
