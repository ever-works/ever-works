import { registerOverviewBlock } from '../registry';

/**
 * Docker on computers (FL-09 P2, FR-30) — the computer Overview's **Runs
 * here** block (CONTRACTS §11.1 `registerOverviewBlock`): the machine's
 * containers with Start / Stop. FL-16 adds its nested computers to it.
 * Client-safe (imported by client components through `./index`).
 */
export const RUNS_HERE_BLOCK_ID = 'fl-09.runs-here';

registerOverviewBlock({
    id: RUNS_HERE_BLOCK_ID,
    surface: 'computer',
    order: 40,
    epic: 'FL-09',
    flag: 'FLEET_MACHINE_FACTS_ENABLED',
    load: () => import('../docker/RunsHereBlock'),
});
