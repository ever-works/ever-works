'use server';

import { agentsAPI } from '@/lib/api/agents';

/**
 * Sessions on computers (FL-04 P2) — the start dialog's Agent picker: the
 * signed-in person's own Agents (an Agent session runs as one of them, and
 * the platform refuses anybody else's). Ids and names only; a failed read
 * answers an empty list, and the dialog says there is no Agent to pick.
 */
export async function listSessionAgentsAction(): Promise<{ id: string; name: string }[]> {
    try {
        const page = await agentsAPI.list({ limit: 100 });
        return page.data
            .filter((agent) => agent.id && agent.name)
            .map((agent) => ({ id: agent.id, name: agent.name }));
    } catch {
        return [];
    }
}
