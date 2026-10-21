import 'server-only';
import type { FleetNodeView } from '@ever-works/contracts';
import { fleetAPI } from '@/lib/api/fleet';
import type { FleetComputerTabProps } from '../registry';
import { SchedulesPanel } from './SchedulesPanel';

/**
 * Schedules on computers (FL-13, spec §5.1) — a computer page's Schedules tab.
 * The computers the viewer may see are read here, on the server, so the
 * dialog can offer Move; the schedules themselves are read by the panel (and
 * re-read while a run is going or a change waits to reach the computer).
 * Registered through `modules/fl-13-schedules.ts`; the registry slot carries
 * `FLEET_COMMANDS_ENABLED` and the `--manage` consent.
 */
export default async function ComputerSchedulesTab({ node }: FleetComputerTabProps) {
    let nodes: FleetNodeView[] = [];
    try {
        nodes = await fleetAPI.listVisibleNodes();
    } catch {
        nodes = [node];
    }
    return <SchedulesPanel node={node} nodes={nodes} />;
}
