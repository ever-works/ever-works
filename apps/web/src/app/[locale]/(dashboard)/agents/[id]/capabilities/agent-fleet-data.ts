import { headers } from 'next/headers';
import { fleetAPI } from '@/lib/api/fleet';
import { isFleetEnabled } from '@/lib/fleet-flags';
import { BROWSER_WORKSPACE_SCOPE_HEADER, parseWorkspaceSelector } from '@/lib/workspace-scope';
import { composeAgentFleet, type AgentFleetData } from '@/components/agents/agent-fleet.shared';

/**
 * Fleet facts for the Capabilities page's Execution section, or null
 * when there is nothing true to show (Fleet disabled on this deployment,
 * or its node list could not be read).
 *
 * Three independent reads, settled independently, then composed by the
 * pure `composeAgentFleet`: which failure hides the section and which
 * one degrades a single column are decisions, and they are tested next
 * to the rest of the section's policy. What stays here is the I/O — the
 * flag, the request scope, the API calls — in its own module (not the
 * page) so those decisions can be exercised without a Next runtime.
 *
 * The affinity read is skipped outright in a PERSONAL workspace: the
 * API answers it with a 400 (a binding is Organization-scoped on top of
 * the owner), and `serverFetch` logs every non-404 failure as an API
 * error — a guaranteed error log on every page view is not degradation,
 * it is noise. The section renders the explanation instead.
 */
export async function loadAgentFleet(agentId: string): Promise<AgentFleetData | null> {
    if (!isFleetEnabled()) return null;

    const organizationScoped = await isOrganizationScoped();
    const [nodes, affinity, preferences] = await Promise.allSettled([
        fleetAPI.listNodes(),
        organizationScoped ? fleetAPI.getAgentAffinity(agentId) : Promise.resolve(null),
        fleetAPI.listExecutionPreferences(),
    ]);

    return composeAgentFleet({ nodes, affinity, preferences }, organizationScoped);
}

/**
 * Whether the request carries an Organization selector. Anything that
 * cannot be read as one — no header, a malformed value, `headers()`
 * unavailable — counts as personal, which is the fail-closed answer: it
 * withholds the Organization-only read rather than issuing it blind.
 */
async function isOrganizationScoped(): Promise<boolean> {
    try {
        const scope = parseWorkspaceSelector((await headers()).get(BROWSER_WORKSPACE_SCOPE_HEADER));
        return scope.kind === 'organization';
    } catch {
        return false;
    }
}
