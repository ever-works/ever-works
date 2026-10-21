import { registerComputerAction } from '../registry';

/**
 * Sessions on computers (FL-04) — what this epic adds to the Fleet module
 * registry IN THE BROWSER (README D9, `components/fleet/registry.ts`):
 *
 *  - "New session ▾" in every computer page's header, taking the place of
 *    FL-01's disabled placeholder, behind `FLEET_SESSIONS_ENABLED`; it acts in
 *    the `sessions` family, so a role the computer's policy leaves out sees it
 *    disabled.
 *
 * The Sessions tab and the session page render on the server and are
 * registered in `./fl-04-sessions.server.ts`. Client-safe (imported by client
 * components through `./index`).
 */
export const NEW_SESSION_ACTION_ID = 'fl-04.new-session';

registerComputerAction({
    id: NEW_SESSION_ACTION_ID,
    placement: 'header',
    order: 10,
    epic: 'FL-04',
    flag: 'FLEET_SESSIONS_ENABLED',
    family: 'sessions',
    replaces: 'new-session',
    load: () => import('../sessions/NewSessionAction'),
});
