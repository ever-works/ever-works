import { notFound } from 'next/navigation';
import type { ComputerNodeOption } from '@ever-works/contracts';
import { agentsAPI } from '@/lib/api/agents';
import { computerAPI } from '@/lib/api/computer';
import { fleetAPI } from '@/lib/api/fleet';
import { missionsAPI } from '@/lib/api/missions';
import { tasksAPI } from '@/lib/api/tasks';
import { isFleetEnabled } from '@/lib/fleet-flags';
import { AgentComputerClient } from '@/components/computer/AgentComputerClient';
import type { ComputerWorkingBrief } from '@/components/computer/ComputerBriefOverlay';
import { selectInitialNode } from '@/components/computer/computer-session.shared';

/** Run statuses that mean the Agent is working right now. */
const IN_FLIGHT_RUN_STATUSES = new Set(['running', 'queued']);

/**
 * Agent computers — Agent detail → Computer.
 *
 * A server component: it reads the computer list (already carrying the
 * Agent's pin from the same affinity the Capabilities tab edits), the fleet
 * stop switch, the working brief and the Agent's profile on the computer
 * that opens first, in parallel, and hands them to the client as props — no
 * client-side fetch on first paint, and no live view is opened here.
 *
 * Every read is defensive: a stale environment answers with a state on the
 * page ("the list of computers could not be loaded"), never a 500. The whole
 * route disappears with `FLEET_ENABLED=false`, like the fleet it watches.
 */
export default async function AgentComputerPage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ node?: string; channel?: string }>;
}) {
    if (!isFleetEnabled()) notFound();
    const { id } = await params;
    const { node: requestedNode, channel: requestedChannel } = await searchParams;

    const [agent, nodes, stop, brief] = await Promise.all([
        agentsAPI.get(id),
        computerAPI.listNodes(id).catch((): ComputerNodeOption[] | null => null),
        fleetAPI.killSwitchState().catch(() => null),
        loadWorkingBrief(id),
    ]);
    if (!agent) notFound();

    const initialNode = selectInitialNode(nodes ?? [], requestedNode ?? null);
    const profile = initialNode ? await computerAPI.getProfile(id, initialNode.id) : null;

    return (
        <AgentComputerClient
            agentId={id}
            agentName={agent.name}
            nodes={nodes}
            initialNodeId={requestedNode ?? null}
            initialChannel={requestedChannel ?? null}
            stop={stop}
            brief={brief}
            profile={profile}
        />
    );
}

/**
 * The Task the Agent is working on right now (and its Mission), or null when
 * nothing is in flight — the overlay then says "Idle — no task in flight".
 */
async function loadWorkingBrief(agentId: string): Promise<ComputerWorkingBrief | null> {
    try {
        const runs = await agentsAPI.listRuns(agentId, { limit: 5 });
        const current = runs.data.find(
            (run) => run.taskId && IN_FLIGHT_RUN_STATUSES.has(run.status),
        );
        if (!current?.taskId) return null;
        const task = await tasksAPI.get(current.taskId);
        if (!task) return null;
        const mission = task.missionId
            ? await missionsAPI.get(task.missionId).catch(() => null)
            : null;
        return { taskId: task.id, taskTitle: task.title, missionTitle: mission?.title ?? null };
    } catch {
        return null;
    }
}
