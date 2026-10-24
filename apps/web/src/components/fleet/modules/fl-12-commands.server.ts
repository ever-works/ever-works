import { registerHubTab } from '../registry';

/**
 * Commands on computers (FL-12) — what this epic registers ON THE SERVER
 * (README D9): the hub's Commands tab, `/fleet/commands` (FL-01 owns the route
 * and `ROUTES.DASHBOARD_FLEET_COMMANDS`; its slot carries the
 * `FLEET_COMMANDS_ENABLED` flag, so with the flag off the tab is the honest
 * placeholder). The panel is a client component; its bundle loads only on
 * this route. Imported by `./server.ts`.
 */
registerHubTab({ id: 'commands', load: () => import('../commands/CommandsPanel') });
