import 'server-only';
import { fleetAPI } from '@/lib/api/fleet';
import { readFleetFeatureFlags } from '@/lib/fleet-flags';
import { FixOnComputerButton } from '@/components/tasks/FixOnComputerButton';

/**
 * Tasks on computers (FL-15 P1, spec FR-1) — whether Task detail shows **Fix
 * with an agent on this computer**: only when `FLEET_SESSIONS_ENABLED` and
 * `FLEET_CHECKOUTS_ENABLED` are both on and the person has at least one
 * computer. Decided on the server; a failed read renders nothing (the Task
 * page never breaks over the fleet).
 */
export async function FixOnComputerSlot({
    taskId,
    taskSlug,
}: {
    taskId: string;
    taskSlug: string;
}) {
    const flags = readFleetFeatureFlags([
        'FLEET_SESSIONS_ENABLED',
        'FLEET_CHECKOUTS_ENABLED',
    ] as const);
    if (flags.FLEET_SESSIONS_ENABLED !== true || flags.FLEET_CHECKOUTS_ENABLED !== true)
        return null;
    const nodes = await fleetAPI.listNodes().catch(() => null);
    if (!Array.isArray(nodes) || nodes.length === 0) return null;
    return <FixOnComputerButton taskId={taskId} taskSlug={taskSlug} hotkey />;
}
