'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Fleet hub (FL-01) — whether the hub is on for this deployment, decided ONCE
 * on the server (`isFleetHubEnabled()` in the dashboard layout) and read by
 * the client surfaces that change with it: the sidebar entry, the runner
 * pill's Manage link and the command palette's hub screens.
 *
 * A context rather than a prop threaded through the sidebar into the pill:
 * the three readers sit at different depths of the shell, and every one of
 * them must get the same answer. Outside the provider the answer is `false`
 * — exactly today's navigation (spec FR-15).
 */
const FleetHubFlagContext = createContext<boolean>(false);

export function FleetHubFlagProvider({
    enabled,
    children,
}: {
    enabled: boolean;
    children: ReactNode;
}) {
    return <FleetHubFlagContext.Provider value={enabled}>{children}</FleetHubFlagContext.Provider>;
}

/** True when `FLEET_ENABLED` and `FLEET_HUB_ENABLED` are both on. */
export function useFleetHubEnabled(): boolean {
    return useContext(FleetHubFlagContext);
}
