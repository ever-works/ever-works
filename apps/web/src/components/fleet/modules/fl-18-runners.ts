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
 * Phase 2 adds the hub Overview's **Actions jobs** panel (R-37: a panel, not
 * a tab or a route): the queued and running jobs of the watched repositories
 * and organisations, the busy count, why no runner can take a queued job, and
 * **Cancel workflow run…**. Client-safe (imported by client components
 * through `./index`).
 */
export const RUNNERS_BLOCK_ID = 'fl-18.runners-block';
export const ACTIONS_JOBS_BLOCK_ID = 'fl-18.actions-jobs';

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

registerOverviewBlock({
    id: ACTIONS_JOBS_BLOCK_ID,
    surface: 'hub',
    // After FL-01's own "needs a look" list (100) — whose `job-unassignable`
    // items point here — and before FL-17's cloud usage (130).
    order: 110,
    epic: 'FL-18',
    flag: 'FLEET_ACTIONS_RUNNERS_ENABLED',
    load: () => import('../runners/ActionsJobsPanel'),
});
