import { registerOverviewBlock } from '../registry';

/**
 * Actions runners on computers (FL-18 P1) — what this epic adds to the Fleet
 * module registry IN THE BROWSER (README D9, CONTRACTS §11.1), behind
 * `FLEET_ACTIONS_RUNNERS_ENABLED`:
 *
 *  - the **Actions runners** block on a computer's Overview: its runners with
 *    their state, last check and acts (Start / Stop / Restart, Logs, Open on
 *    GitHub, Remove runner…), and the **Install runners** button — FL-01's
 *    registry has no header-action entry point for it (plan §8, T-15).
 *
 * The hub's **Actions jobs** panel is phase 2. Client-safe (imported by client
 * components through `./index`).
 */
export const RUNNERS_BLOCK_ID = 'fl-18.runners-block';

registerOverviewBlock({
    id: RUNNERS_BLOCK_ID,
    surface: 'computer',
    // After the machine's own blocks (health 10, cloud 15, history 20, servers
    // and "runs here" 40), before FL-01's "needs a look" (100).
    order: 50,
    epic: 'FL-18',
    flag: 'FLEET_ACTIONS_RUNNERS_ENABLED',
    load: () => import('../runners/RunnersBlock'),
});
