import { registerComputerTab, registerSessionPage } from '../registry';

/**
 * Sessions on computers (FL-04) — what this epic registers ON THE SERVER
 * (README D9): the computer page's Sessions tab (the first page of sessions is
 * read before paint) and the one session page, `/fleet/sessions/[id]` (FL-01
 * owns the route; FL-04 fills it here with its flag). Imported by
 * `./server.ts`.
 */
registerComputerTab({ id: 'sessions', load: () => import('../sessions/SessionsTabServer') });

registerSessionPage({
    epic: 'FL-04',
    flag: 'FLEET_SESSIONS_ENABLED',
    load: () => import('../sessions/SessionPage'),
});
