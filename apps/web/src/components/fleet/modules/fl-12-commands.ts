import { registerComputerAction, registerOverviewBlock } from '../registry';

/**
 * Commands on computers (FL-12 P2) — what this epic adds to the Fleet module
 * registry IN THE BROWSER (README D9, `components/fleet/registry.ts`), behind
 * `FLEET_COMMANDS_ENABLED`:
 *
 *  - "Run a command…" in every computer page's ⋯ menu (family `commands`), which
 *    opens the hub's Commands tab with that computer the only one preselected
 *    (spec §5.3);
 *  - "Last command" on the computer's Overview — the viewer's own latest run
 *    there.
 *
 * The hub tab itself renders on the server (`./fl-12-commands.server.ts`).
 * Client-safe (imported by client components through `./index`).
 */
export const RUN_COMMAND_ACTION_ID = 'fl-12.run-command';
export const LAST_COMMAND_BLOCK_ID = 'fl-12.last-command';

registerComputerAction({
    id: RUN_COMMAND_ACTION_ID,
    placement: 'menu',
    order: 30,
    epic: 'FL-12',
    flag: 'FLEET_COMMANDS_ENABLED',
    family: 'commands',
    load: () => import('../commands/RunCommandMenuItem'),
});

registerOverviewBlock({
    id: LAST_COMMAND_BLOCK_ID,
    surface: 'computer',
    order: 300,
    epic: 'FL-12',
    flag: 'FLEET_COMMANDS_ENABLED',
    load: () => import('../commands/LastCommandBlock'),
});
