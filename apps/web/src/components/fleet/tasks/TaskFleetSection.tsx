import 'server-only';
import type { FleetCheckoutView, FleetSessionView } from '@ever-works/contracts';
import { agentsAPI } from '@/lib/api/agents';
import { fleetAPI } from '@/lib/api/fleet';
import { fleetCheckoutsAPI } from '@/lib/api/fleet-checkouts';
import { fleetTaskHandoffAPI } from '@/lib/api/fleet-task-handoff';
import type { Task } from '@/lib/api/tasks';
import { readFleetFeatureFlags } from '@/lib/fleet-flags';
import { TaskFleetBlock } from './TaskFleetBlock';

/**
 * Tasks on computers (FL-15 P1, spec FR-9, S5, T-07) — the Task page's
 * **Computer** block, server-read: the Task's latest session on a computer
 * (`GET /api/fleet/sessions?taskId=&limit=1` — a session knows its Run, a
 * Run knows its Task), the computer it ran on, its Agent, and its checkout
 * with the git line. Nothing new is stored.
 *
 * Rendered only while `FLEET_SESSIONS_ENABLED` is on; every read is
 * `.catch()`-ed, so a failed read renders the block's empty state, never a
 * broken Task page.
 */
export async function TaskFleetSection({ task }: { task: Task }) {
    const flags = readFleetFeatureFlags([
        'FLEET_SESSIONS_ENABLED',
        'FLEET_CHECKOUTS_ENABLED',
    ] as const);
    if (flags.FLEET_SESSIONS_ENABLED !== true) return null;
    const page = await fleetTaskHandoffAPI.sessionsForTask(task.id, 1).catch(() => null);
    const session: FleetSessionView | null = page?.sessions?.[0] ?? null;
    let nodeName: string | null = null;
    let nodeOnline = false;
    let nodeLastSeenAt: string | null = null;
    let agentName: string | null = null;
    let checkout: FleetCheckoutView | null = null;
    if (session) {
        const [nodes, agent, checkoutView] = await Promise.all([
            fleetAPI.listVisibleNodes().catch(() => null),
            session.agentId
                ? agentsAPI.get(session.agentId).catch(() => null)
                : Promise.resolve(null),
            session.checkoutId && flags.FLEET_CHECKOUTS_ENABLED === true
                ? fleetCheckoutsAPI.get(session.checkoutId).catch(() => null)
                : Promise.resolve(null),
        ]);
        const node = (nodes ?? []).find((row) => row.id === session.nodeId);
        nodeName = node?.name ?? null;
        nodeOnline = node?.status === 'online';
        nodeLastSeenAt = node?.lastHeartbeatAt ?? null;
        agentName = agent?.name ?? null;
        checkout = checkoutView;
    }
    return (
        <TaskFleetBlock
            task={task}
            session={session}
            nodeName={nodeName}
            nodeOnline={nodeOnline}
            nodeLastSeenAt={nodeLastSeenAt}
            agentName={agentName}
            checkout={checkout}
        />
    );
}
