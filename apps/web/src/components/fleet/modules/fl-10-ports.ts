import { registerOverviewBlock } from '../registry';

/**
 * Servers and ports (FL-10) — what this epic adds to the Fleet module
 * registry IN THE BROWSER (README D9, `components/fleet/registry.ts`):
 *
 *  - the **Servers** block on every computer's Overview (spec §5.6, FR-7):
 *    up to three web servers and the count of the other ports, each opening
 *    the Ports tab with that row selected; behind `FLEET_MACHINE_FACTS_ENABLED`.
 *
 * The Ports tab itself is registered on the server, in
 * `./fl-10-ports.server.ts`. Client-safe (imported by client components
 * through `./index`).
 */
export const SERVERS_BLOCK_ID = 'fl-10.servers';

registerOverviewBlock({
    id: SERVERS_BLOCK_ID,
    surface: 'computer',
    order: 40,
    epic: 'FL-10',
    flag: 'FLEET_MACHINE_FACTS_ENABLED',
    load: () => import('../ports/ServersBlock'),
});
