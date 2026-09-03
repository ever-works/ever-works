import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `fleetAPI` agent-affinity helpers — the endpoint shape.
 *
 * Two things are pinned. First, the path is relative to `/api` (no
 * leading `/api`), the same double-prefix guard every other `lib/api`
 * spec carries. Second, the agent id — which arrives from a Server
 * Action argument, i.e. from the browser — is encoded as ONE path
 * segment, so a crafted value carrying `/` or `..` cannot be
 * dot-segment-normalised by `fetch` onto a different `/api/*` route
 * under the caller's own bearer.
 */

const { serverFetchMock, serverMutationMock } = vi.hoisted(() => ({
    serverFetchMock: vi.fn(),
    serverMutationMock: vi.fn(),
}));

vi.mock('./server-api', () => ({
    serverFetch: serverFetchMock,
    serverMutation: serverMutationMock,
}));

async function importApi() {
    return import('./fleet');
}

const AGENT_ID = '5d2f7a1e-2c4b-4c8e-9a1f-0b3c6d7e8f90';
const BINDING = {
    agentId: AGENT_ID,
    nodeId: 'node-1',
    organizationId: 'org-1',
    createdAt: null,
    updatedAt: null,
};

beforeEach(() => {
    serverFetchMock.mockReset();
    serverMutationMock.mockReset();
    serverFetchMock.mockResolvedValue(BINDING);
    serverMutationMock.mockResolvedValue(BINDING);
});
afterEach(() => vi.resetModules());

describe('fleetAPI agent affinity — endpoint shape', () => {
    it('getAgentAffinity GETs /fleet/agents/:id/node-affinity WITHOUT a leading /api', async () => {
        const { fleetAPI } = await importApi();
        await expect(fleetAPI.getAgentAffinity(AGENT_ID)).resolves.toEqual(BINDING);
        expect(serverFetchMock).toHaveBeenCalledWith(`/fleet/agents/${AGENT_ID}/node-affinity`);
    });

    /** Unbound is a JSON `null` on the wire; `serverFetch` may collapse it to `undefined`. */
    it('getAgentAffinity answers null for an unbound agent, whichever way the body arrives', async () => {
        const { fleetAPI } = await importApi();
        serverFetchMock.mockResolvedValueOnce(null);
        await expect(fleetAPI.getAgentAffinity(AGENT_ID)).resolves.toBeNull();
        serverFetchMock.mockResolvedValueOnce(undefined);
        await expect(fleetAPI.getAgentAffinity(AGENT_ID)).resolves.toBeNull();
    });

    it('setAgentAffinity PUTs the node id to the same resource', async () => {
        const { fleetAPI } = await importApi();
        await fleetAPI.setAgentAffinity(AGENT_ID, 'node-1');
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: `/fleet/agents/${AGENT_ID}/node-affinity`,
            data: { nodeId: 'node-1' },
            method: 'PUT',
            wrapInData: false,
        });
    });

    it('clearAgentAffinity DELETEs the same resource', async () => {
        const { fleetAPI } = await importApi();
        await fleetAPI.clearAgentAffinity(AGENT_ID);
        expect(serverMutationMock).toHaveBeenCalledWith({
            endpoint: `/fleet/agents/${AGENT_ID}/node-affinity`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    });

    it('encodes the agent id as one path segment so a crafted value cannot reach another route', async () => {
        const { fleetAPI } = await importApi();
        const crafted = 'x/../../agents';
        const expected = `/fleet/agents/${encodeURIComponent(crafted)}/node-affinity`;
        expect(expected).not.toContain('/../');

        await fleetAPI.getAgentAffinity(crafted);
        expect(serverFetchMock).toHaveBeenCalledWith(expected);

        await fleetAPI.setAgentAffinity(crafted, 'node-1');
        expect(serverMutationMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ endpoint: expected, method: 'PUT' }),
        );

        await fleetAPI.clearAgentAffinity(crafted);
        expect(serverMutationMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ endpoint: expected, method: 'DELETE' }),
        );
    });
});
