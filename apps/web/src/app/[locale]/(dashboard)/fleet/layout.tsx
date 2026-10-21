import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isFleetEnabled, isFleetHubEnabled } from '@/lib/fleet-flags';

/**
 * Fleet hub (FL-01, README D1) — every `/fleet/*` route sits behind
 * `FLEET_ENABLED` AND `FLEET_HUB_ENABLED`: with either off the whole tree
 * answers 404 (spec U2, U3), so a deployment without the hub has no page
 * whose every call fails. The hub tabs render their own frame
 * (`FleetHubFrame`); the computer page renders its own header and tab strip.
 */
export default function FleetLayout({ children }: { children: ReactNode }) {
    if (!isFleetEnabled() || !isFleetHubEnabled()) notFound();
    return <>{children}</>;
}
