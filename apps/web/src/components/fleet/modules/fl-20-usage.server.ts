import { registerHubTab } from '../registry';

/**
 * Usage & cost on the fleet (FL-20 P2) — what this epic registers ON THE
 * SERVER (README D9): the hub's Usage tab, `/fleet/usage` (FL-01 owns the
 * route and `ROUTES.DASHBOARD_FLEET_USAGE`; its slot carries
 * `FLEET_USAGE_SCAN_ENABLED`, so with the flag off the tab is the honest
 * placeholder). The panel is a client component; its bundle loads only on
 * this route. Imported by `./server.ts`.
 */
registerHubTab({ id: 'usage', load: () => import('../usage/UsagePanel') });
