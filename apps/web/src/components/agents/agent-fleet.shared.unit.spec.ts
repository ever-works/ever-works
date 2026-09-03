import { describe, expect, it } from 'vitest';
import type {
    FleetAgentNodeAffinityView,
    FleetExecutionPreferenceView,
    FleetNodeView,
} from '@ever-works/contracts';
import {
    composeAgentFleet,
    describeAccountExecutionPreference,
    nodeAvailability,
    preferredNodeState,
    selectableFleetNodes,
    type AgentFleetReads,
} from './agent-fleet.shared';

/**
 * Execution section — the policy half.
 *
 * What these pin: which nodes may be offered as a binding target, what a
 * bound node's status means for the Agent's jobs, which routing row the
 * read-only display reports as "in force", and how the page's three
 * settled reads become the section's input (which failure hides it,
 * which one degrades a single column).
 */

function node(over: Partial<FleetNodeView> = {}): FleetNodeView {
    return {
        id: 'node-1',
        name: 'Office PC',
        kind: 'desktop-node',
        status: 'online',
        platform: 'win32/x64',
        version: '0.1.0',
        capabilities: ['terminal'],
        lastHeartbeatAt: '2026-09-01T10:00:00.000Z',
        createdAt: '2026-08-01T00:00:00.000Z',
        persisted: true,
        ...over,
    };
}

function preference(
    over: Partial<FleetExecutionPreferenceView> = {},
): FleetExecutionPreferenceView {
    return {
        id: 'pref-1',
        scopeType: 'user',
        scopeId: null,
        mode: 'cloud',
        createdAt: null,
        updatedAt: null,
        ...over,
    };
}

describe('nodeAvailability', () => {
    it('maps online to available', () => {
        expect(nodeAvailability('online')).toBe('available');
    });

    /**
     * A paused node is usually still heartbeating — calling it "offline"
     * would send the operator to check the machine instead of the drain.
     */
    it('maps the operator-drained statuses to draining', () => {
        expect(nodeAvailability('paused')).toBe('draining');
        expect(nodeAvailability('disabled')).toBe('draining');
    });

    it('maps offline and never-enrolled to offline', () => {
        expect(nodeAvailability('offline')).toBe('offline');
        expect(nodeAvailability('enrolling')).toBe('offline');
    });
});

describe('selectableFleetNodes', () => {
    it('keeps enrolled desktop and headless nodes in their original order', () => {
        const desktop = node();
        const headless = node({ id: 'node-2', kind: 'node', name: 'CI box' });
        expect(selectableFleetNodes([desktop, headless])).toEqual([desktop, headless]);
    });

    /**
     * Cluster rows are inventory, not runners: the platform never leases
     * onto them and the affinity API refuses their ids.
     */
    it('drops cluster-sourced and non-persisted rows', () => {
        const cluster = node({ id: 'k8s-1', kind: 'k8s', persisted: false });
        const ghost = node({ id: 'ghost', persisted: false });
        expect(selectableFleetNodes([cluster, node(), ghost])).toEqual([node()]);
    });
});

describe('preferredNodeState', () => {
    const nodes = [node(), node({ id: 'node-2', name: 'Laptop', status: 'paused' })];

    it('is "any" when unbound', () => {
        expect(preferredNodeState(null, nodes)).toEqual({ kind: 'any' });
    });

    it('resolves a bound node together with its availability', () => {
        expect(preferredNodeState('node-2', nodes)).toEqual({
            kind: 'node',
            node: nodes[1],
            availability: 'draining',
        });
    });

    /**
     * A binding to a removed node is still in force server-side (its jobs
     * wait for a machine that will never come), so it must surface rather
     * than collapse to "any".
     */
    it('reports a binding whose node is no longer listed as missing', () => {
        expect(preferredNodeState('gone', nodes)).toEqual({ kind: 'missing', nodeId: 'gone' });
    });
});

describe('describeAccountExecutionPreference', () => {
    it('reports the platform default when nothing is configured', () => {
        expect(describeAccountExecutionPreference([])).toEqual({
            mode: 'local-fallback',
            configured: false,
            overrideCount: 0,
        });
    });

    it('reports the account row as configured', () => {
        expect(describeAccountExecutionPreference([preference({ mode: 'local-wait' })])).toEqual({
            mode: 'local-wait',
            configured: true,
            overrideCount: 0,
        });
    });

    /**
     * Work / Goal rows beat the account row only inside their own scope;
     * the Agent page has no such scope, so they are counted, not applied.
     */
    it('counts narrower overrides without letting them change the account mode', () => {
        const rows = [
            preference({ id: 'w', scopeType: 'work', scopeId: 'work-1', mode: 'cloud' }),
            preference({ id: 'g', scopeType: 'goal', scopeId: 'goal-1', mode: 'local-wait' }),
        ];
        expect(describeAccountExecutionPreference(rows)).toEqual({
            mode: 'local-fallback',
            configured: false,
            overrideCount: 2,
        });
    });
});

describe('composeAgentFleet', () => {
    function fulfilled<T>(value: T): PromiseFulfilledResult<T> {
        return { status: 'fulfilled', value };
    }
    function rejected(reason: string): PromiseRejectedResult {
        return { status: 'rejected', reason: new Error(reason) };
    }
    function affinity(nodeId: string): FleetAgentNodeAffinityView {
        return {
            agentId: 'agent-1',
            nodeId,
            organizationId: 'org-1',
            createdAt: null,
            updatedAt: null,
        };
    }
    const healthy: AgentFleetReads = {
        nodes: fulfilled([node()]),
        affinity: fulfilled(affinity('node-1')),
        preferences: fulfilled([preference()]),
    };

    it('adopts every read when all three succeed in an Organization workspace', () => {
        expect(composeAgentFleet(healthy, true)).toEqual({
            nodes: [node()],
            affinity: { available: true, nodeId: 'node-1' },
            preferences: [preference()],
        });
    });

    /**
     * Both the picker and the "no nodes yet" pointer are statements about
     * the node list; without it the section would claim the fleet is empty.
     */
    it('hides the whole section when the node list could not be read', () => {
        expect(composeAgentFleet({ ...healthy, nodes: rejected('503') }, true)).toBeNull();
    });

    it('degrades only the affinity column when that read failed', () => {
        expect(composeAgentFleet({ ...healthy, affinity: rejected('500') }, true)).toEqual({
            nodes: [node()],
            affinity: { available: false, reason: 'unavailable' },
            preferences: [preference()],
        });
    });

    it('degrades only the routing column when the preference read failed', () => {
        expect(composeAgentFleet({ ...healthy, preferences: rejected('500') }, true)).toEqual({
            nodes: [node()],
            affinity: { available: true, nodeId: 'node-1' },
            preferences: null,
        });
    });

    /** Unbound is `null` on the wire; `serverFetch` may collapse it to `undefined`. */
    it('treats a null or empty affinity answer as unbound', () => {
        expect(
            composeAgentFleet({ ...healthy, affinity: fulfilled(null) }, true)?.affinity,
        ).toEqual({
            available: true,
            nodeId: null,
        });
        expect(
            composeAgentFleet({ ...healthy, affinity: fulfilled(undefined) }, true)?.affinity,
        ).toEqual({ available: true, nodeId: null });
    });

    /**
     * The page never issues the affinity read in a personal workspace, so
     * whatever the placeholder settled to must not leak into the state.
     */
    it('reports personal scope regardless of what the affinity slot holds', () => {
        expect(composeAgentFleet(healthy, false)?.affinity).toEqual({
            available: false,
            reason: 'personal-scope',
        });
        expect(
            composeAgentFleet({ ...healthy, affinity: rejected('400') }, false)?.affinity,
        ).toEqual({
            available: false,
            reason: 'personal-scope',
        });
    });
});
