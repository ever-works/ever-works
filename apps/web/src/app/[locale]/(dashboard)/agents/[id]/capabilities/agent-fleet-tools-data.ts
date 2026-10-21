import { fleetAPI } from '@/lib/api/fleet';
import { isFleetEnabled } from '@/lib/fleet-flags';
import type { AgentFleetToolsData } from '@/components/agents/agent-fleet-tools.shared';

/**
 * FL-19 — the facts for the Capabilities "Fleet tools" block (spec FR-24):
 * null when Fleet is off on this deployment (the block hides), an error marker
 * when the gate view could not be read (the block shows Retry), the view
 * otherwise. Its own module, like `agent-fleet-data.ts`, so the decision can be
 * exercised without a Next runtime.
 */
export async function loadAgentFleetTools(agentId: string): Promise<AgentFleetToolsData> {
    if (!isFleetEnabled()) return null;
    try {
        const view = await fleetAPI.toolsGate(agentId);
        return view ? { kind: 'ready', view } : { kind: 'error' };
    } catch {
        return { kind: 'error' };
    }
}
