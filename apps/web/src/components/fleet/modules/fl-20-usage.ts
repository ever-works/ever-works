import { registerOverviewBlock } from '../registry';

/**
 * Usage & cost on the fleet (FL-20) — what this epic adds to the Fleet module
 * registry IN THE BROWSER (README D9), behind `FLEET_USAGE_SCAN_ENABLED`:
 * the usage line on a computer's Overview (spec FR-14, §5.5) — the 7-day cost
 * at list price, the scan state and its age, or the opt-in command. The
 * session card's cost chip fills FL-05's `cost` slot directly (R-22); the hub
 * Usage tab is registered on the server (P2). Client-safe (imported by client
 * components through `./index`).
 */
export const USAGE_OVERVIEW_LINE_ID = 'fl-20.usage-line';

registerOverviewBlock({
    id: USAGE_OVERVIEW_LINE_ID,
    surface: 'computer',
    // After FL-17's Cloud block (15) and the health blocks (10, 20): money is
    // the next thing the page answers, before "needs a look" (100).
    order: 30,
    epic: 'FL-20',
    flag: 'FLEET_USAGE_SCAN_ENABLED',
    load: () => import('../usage/ComputerOverviewUsageLine'),
});
