import 'server-only';
import type { ComputerNodeOption, NodeAgentProfileView } from '@ever-works/contracts';
import { serverFetch } from './server-api';

/**
 * Agent computers — the owner-facing reads the computer page server-renders
 * with (`api/agents/:id/computer`, see `apps/api/src/computer/computer.controller.ts`).
 *
 * Only the two first-paint reads live here. Everything that changes a live
 * view (open, quality, refresh, end, the attach token, a profile reset) goes
 * through the BFF routes under `app/api/agents/[id]/computer/`, so an attach
 * token is minted server-side and never round-trips through client code.
 */
export const computerAPI = {
    /**
     * Every computer the owner has, ordered for the picker (the Agent's
     * pinned machine first), each with the channels it can serve and, when
     * it cannot be watched, the one reason why. The pin itself is read from
     * the Agent's affinity — the same binding the Capabilities tab edits.
     */
    listNodes: async (agentId: string) => {
        return serverFetch<ComputerNodeOption[]>(`/agents/${agentId}/computer/nodes`, {
            method: 'GET',
        });
    },

    /** The Agent's own logins and files on one computer; null when it never opened there. */
    getProfile: async (agentId: string, nodeId: string): Promise<NodeAgentProfileView | null> => {
        try {
            return await serverFetch<NodeAgentProfileView>(
                `/agents/${agentId}/computer/profile?nodeId=${encodeURIComponent(nodeId)}`,
                { method: 'GET' },
            );
        } catch {
            return null;
        }
    },
};
