import { FLEET_CLEAR_MODEL_THROTTLE_COMMAND } from '@ever-works/contracts';
import { clearFleetNodeModelThrottleAction } from '@/app/actions/settings/fleet';
import { registerNeedsALookCommand } from '../overview/needs-a-look-commands';
import { registerOverviewBlock } from '../registry';

/**
 * Computer health (FL-03) — what this epic adds to the Fleet module registry
 * (README D9, `components/fleet/registry.ts`):
 *
 *  - the metrics block at the top of every computer page's Overview tab. It
 *    carries the computer's state in words and its one fix, so it renders
 *    before every other block. No `flag`: the snapshot and the state are
 *    report-only and ship on; only the history behind them is
 *    `FLEET_HEALTH_HISTORY_ENABLED`, which the block reads from the health
 *    answer itself;
 *  - the handler behind "Clear limit now" on a `node-throttled` row of
 *    "needs a look": the existing, audited clear route for the row's
 *    computer, with no provider — every usage limit in force on it, which is
 *    what the row says.
 *
 * Client-safe (imported by client components through `./index`).
 */
export const HEALTH_METRICS_BLOCK_ID = 'fl-03.health-metrics';

registerOverviewBlock({
    id: HEALTH_METRICS_BLOCK_ID,
    surface: 'computer',
    order: 10,
    epic: 'FL-03',
    load: () => import('../health/overview/HealthMetricsBlock'),
});

registerNeedsALookCommand(FLEET_CLEAR_MODEL_THROTTLE_COMMAND, async (item) => {
    const result = await clearFleetNodeModelThrottleAction(item.nodeId, null);
    return result.success ? { ok: true } : { ok: false, error: result.error ?? undefined };
});
