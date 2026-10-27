import { NotFoundException } from '@nestjs/common';
import type { FleetNodeView } from '@ever-works/contracts';
import {
    buildFleetHealthTools,
    FLEET_HEALTH_TOOL_ANNOTATIONS,
    FLEET_NODES_WAKE_TOOL,
} from '../agent-fleet-health-tools';

/**
 * Computer health (FL-03, T-22) — the Agent tool shapes handed to FL-19:
 * annotations, the read-only envelopes, and the wake descriptor that is
 * exported but never assembled here.
 */

const NODE_ID = '11111111-1111-4111-8111-111111111111';

function view(overrides: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: NODE_ID,
        name: 'build-01',
        kind: 'node',
        status: 'online',
        platform: 'linux/x64',
        version: '0.4.0',
        capabilities: [],
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: null,
        persisted: true,
        health: { at: new Date().toISOString(), cpuPercent: 31 },
        ...overrides,
    };
}

function tools(overrides: { getVisibleForUser?: jest.Mock; history?: jest.Mock } = {}) {
    const getVisibleForUser =
        overrides.getVisibleForUser ?? jest.fn(async () => ({ view: view(), role: 'owner' }));
    const history =
        overrides.history ??
        jest.fn(async (nodeId: string, range: string) => ({ nodeId, range, disabled: true }));
    const forNodes = jest.fn(async () => ({ items: [], partial: false }));
    const built = buildFleetHealthTools({
        userId: 'user-1',
        service: {
            getVisibleForUser,
            listVisibleForUser: jest.fn(async () => [view()]),
        } as never,
        history: { history, isHistoryEnabled: () => true } as never,
        needsALook: { forNodes } as never,
    });
    return { built, getVisibleForUser, history, forNodes };
}

describe('FL-03 health tools', () => {
    it('annotates health and needs-a-look read-only, wake state-changing but not destructive', () => {
        expect(FLEET_HEALTH_TOOL_ANNOTATIONS.fleet_nodes_health).toEqual({
            readOnly: true,
            destructive: false,
            confirmationClass: 'plain',
        });
        expect(FLEET_HEALTH_TOOL_ANNOTATIONS.fleet_nodes_needs_a_look.readOnly).toBe(true);
        expect(FLEET_NODES_WAKE_TOOL.annotations).toEqual({
            readOnly: false,
            destructive: false,
            confirmationClass: 'plain',
        });
    });

    it('assembles the two read-only tools and never the wake', () => {
        const { built } = tools();
        expect(built.map((tool) => tool.name)).toEqual([
            'fleet_nodes_health',
            'fleet_nodes_needs_a_look',
        ]);
    });

    it('answers the same snapshot and state the page shows, scoped to the caller (spec S9)', async () => {
        const { built, getVisibleForUser } = tools();
        const result = (await built[0]!.invoke({ nodeId: NODE_ID })) as Record<string, unknown>;
        expect(getVisibleForUser).toHaveBeenCalledWith('user-1', NODE_ID);
        expect(result).toMatchObject({
            nodeId: NODE_ID,
            snapshot: { cpuPercent: 31 },
            stale: false,
            state: { state: 'online' },
            fresh: false,
        });
    });

    it('adds the history when a range is asked for, and refuses an unknown range', async () => {
        const { built, history } = tools();
        const result = (await built[0]!.invoke({ nodeId: NODE_ID, range: '7d' })) as Record<
            string,
            unknown
        >;
        expect(history).toHaveBeenCalledWith(NODE_ID, '7d');
        expect(result.history).toEqual({ nodeId: NODE_ID, range: '7d', disabled: true });
        expect(await built[0]!.invoke({ nodeId: NODE_ID, range: '1y' })).toEqual({
            error: { code: 'invalid', hint: 'range must be one of 1h, 24h, 7d, 90d' },
        });
    });

    it('answers not_found for a computer outside the caller’s view', async () => {
        const { built } = tools({
            getVisibleForUser: jest.fn(async () => {
                throw new NotFoundException('Fleet node x not found');
            }),
        });
        expect(await built[0]!.invoke({ nodeId: NODE_ID })).toEqual({
            error: { code: 'not_found', hint: 'no such computer' },
        });
    });

    it('lists needs-a-look for the visible computers, or one of them', async () => {
        const { built, forNodes } = tools();
        await built[1]!.invoke({});
        expect(forNodes).toHaveBeenCalledWith([expect.objectContaining({ id: NODE_ID })], {
            userId: 'user-1',
        });
        expect(await built[1]!.invoke({ nodeId: 'someone-else' })).toEqual({
            error: { code: 'not_found', hint: 'no such computer' },
        });
    });
});
