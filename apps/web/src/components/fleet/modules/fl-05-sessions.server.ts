import { registerHubTab } from '../registry';

/**
 * Session status & board (FL-05 P3) — what this epic registers ON THE SERVER
 * (README D9): the hub's Fleet → Sessions tab, the live sessions grouped by
 * computer (FL-01 owns the route `fleet/sessions/page.tsx`; the tab renders
 * behind `FLEET_SESSIONS_ENABLED`, the hub's own gate for the slot). The
 * Activity → Sessions view lives on the Activity page itself.
 */
registerHubTab({ id: 'sessions', load: () => import('../sessions/SessionsByComputer') });
