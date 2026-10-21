import 'server-only';
import type { ReactNode } from 'react';
import { fleetAPI } from '@/lib/api/fleet';
import { readFleetFeatureFlags } from '@/lib/fleet-flags';
import { FleetTaskHandoffProvider } from './handoff-context';

/**
 * Tasks on computers (FL-15 P1, spec FR-1, T-06) — the board's gate for
 * **Fix with an agent on this computer**: on only when `FLEET_SESSIONS_ENABLED`
 * and `FLEET_CHECKOUTS_ENABLED` are both on and the person has at least one
 * computer. One read for the whole board; a failed read leaves it off.
 */
export async function FleetTaskHandoffGate({ children }: { children: ReactNode }) {
    const flags = readFleetFeatureFlags(['FLEET_SESSIONS_ENABLED', 'FLEET_CHECKOUTS_ENABLED'] as const);
    let enabled = false;
    if (flags.FLEET_SESSIONS_ENABLED === true && flags.FLEET_CHECKOUTS_ENABLED === true) {
        const nodes = await fleetAPI.listNodes().catch(() => null);
        enabled = Array.isArray(nodes) && nodes.length > 0;
    }
    return <FleetTaskHandoffProvider enabled={enabled}>{children}</FleetTaskHandoffProvider>;
}
