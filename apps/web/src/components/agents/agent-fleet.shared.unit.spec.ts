import { describe, expect, it } from 'vitest';
import type { FleetExecutionPreferenceView, FleetNodeView } from '@ever-works/contracts';
import {
    describeAccountExecutionPreference,
    nodeAvailability,
    preferredNodeState,
    selectableFleetNodes,
} from './agent-fleet.shared';

/**
 * Execution section — the policy half.
 *
 * What these pin: which nodes may be offered as a binding target, what a
 * bound node's status means for the Agent's jobs, and which routing row
 * the read-only display reports as "in force".
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
