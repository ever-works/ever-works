import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetNodeView } from '@ever-works/contracts';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';

/**
 * Capabilities page — the fleet loader's I/O decisions.
 *
 * `composeAgentFleet` (agent-fleet.shared.unit.spec.ts) pins how settled
 * reads become the section's state; what this spec pins is what the
 * loader does BEFORE settling: nothing at all when Fleet is disabled,
 * and never the Organization-only affinity read in a personal workspace
 * — the API would answer 400 and `serverFetch` would log it as an API
 * error on every page view.
 */

const {
    headersMock,
    isFleetEnabledMock,
    listNodesMock,
    getAgentAffinityMock,
    listPreferencesMock,
} = vi.hoisted(() => ({
    headersMock: vi.fn(),
    isFleetEnabledMock: vi.fn(),
    listNodesMock: vi.fn(),
    getAgentAffinityMock: vi.fn(),
    listPreferencesMock: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: headersMock }));
vi.mock('@/lib/fleet-flags', () => ({ isFleetEnabled: isFleetEnabledMock }));
vi.mock('@/lib/api/fleet', () => ({
    fleetAPI: {
        listNodes: listNodesMock,
        getAgentAffinity: getAgentAffinityMock,
        listExecutionPreferences: listPreferencesMock,
    },
}));

import { loadAgentFleet } from './agent-fleet-data';

const AGENT_ID = 'agent-1';

function node(over: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: 'node-1',
        name: 'Office PC',
        kind: 'desktop-node',
        status: 'online',
        platform: 'win32/x64',
        version: '0.1.0',
        capabilities: [],
        lastHeartbeatAt: null,
        createdAt: null,
        persisted: true,
        ...over,
    };
}

function requestScope(selector: string) {
    headersMock.mockResolvedValue(new Headers({ [BROWSER_WORKSPACE_SCOPE_HEADER]: selector }));
}

beforeEach(() => {
    vi.clearAllMocks();
    isFleetEnabledMock.mockReturnValue(true);
    listNodesMock.mockResolvedValue([node()]);
    getAgentAffinityMock.mockResolvedValue(null);
    listPreferencesMock.mockResolvedValue([]);
    requestScope('org:acme');
});

describe('loadAgentFleet', () => {
    it('returns null without touching the API when Fleet is disabled', async () => {
        isFleetEnabledMock.mockReturnValue(false);

        await expect(loadAgentFleet(AGENT_ID)).resolves.toBeNull();
        expect(listNodesMock).not.toHaveBeenCalled();
        expect(getAgentAffinityMock).not.toHaveBeenCalled();
        expect(listPreferencesMock).not.toHaveBeenCalled();
    });

    it('reads the binding for the agent in an Organization workspace', async () => {
        getAgentAffinityMock.mockResolvedValue({
            agentId: AGENT_ID,
            nodeId: 'node-1',
            organizationId: 'org-1',
            createdAt: null,
            updatedAt: null,
        });

        await expect(loadAgentFleet(AGENT_ID)).resolves.toEqual({
            nodes: [node()],
            affinity: { available: true, nodeId: 'node-1' },
            preferences: [],
        });
        expect(getAgentAffinityMock).toHaveBeenCalledWith(AGENT_ID);
    });

    it('skips the affinity read in a personal workspace and says so', async () => {
        requestScope('personal');

        await expect(loadAgentFleet(AGENT_ID)).resolves.toEqual({
            nodes: [node()],
            affinity: { available: false, reason: 'personal-scope' },
            preferences: [],
        });
        expect(getAgentAffinityMock).not.toHaveBeenCalled();
        expect(listNodesMock).toHaveBeenCalledTimes(1);
        expect(listPreferencesMock).toHaveBeenCalledTimes(1);
    });

    /**
     * Fail closed: a selector that cannot be read as an Organization must
     * withhold the Organization-only read, not issue it blind.
     */
    it.each([
        ['a malformed selector', () => requestScope('org:Not A Slug')],
        ['a missing selector', () => headersMock.mockResolvedValue(new Headers())],
        [
            'headers() being unavailable',
            () => headersMock.mockRejectedValue(new Error('outside a request scope')),
        ],
    ])('treats %s as a personal workspace', async (_label, arrange) => {
        arrange();

        const fleet = await loadAgentFleet(AGENT_ID);
        expect(fleet?.affinity).toEqual({ available: false, reason: 'personal-scope' });
        expect(getAgentAffinityMock).not.toHaveBeenCalled();
    });

    it('lets one failing read degrade only its own column', async () => {
        getAgentAffinityMock.mockRejectedValue(new Error('500'));
        listPreferencesMock.mockRejectedValue(new Error('500'));

        await expect(loadAgentFleet(AGENT_ID)).resolves.toEqual({
            nodes: [node()],
            affinity: { available: false, reason: 'unavailable' },
            preferences: null,
        });
    });

    it('hides the section when the node list cannot be read', async () => {
        listNodesMock.mockRejectedValue(new Error('503'));
        await expect(loadAgentFleet(AGENT_ID)).resolves.toBeNull();
    });
});
