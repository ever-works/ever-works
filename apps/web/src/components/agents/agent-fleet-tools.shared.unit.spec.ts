import { describe, expect, it } from 'vitest';
import type { FleetToolsGateFamilyRow, FleetToolsGateView } from '@ever-works/contracts';
import {
    agentFleetToolsHasComputers,
    agentFleetToolsRows,
    fleetToolsFixHref,
    fleetToolsGateMessageKey,
} from './agent-fleet-tools.shared';

/** FL-19 T-12 — what each Fleet tools row shows (spec FR-24, §5.1, ACC-FL19-15). */

function family(over: Partial<FleetToolsGateFamilyRow>): FleetToolsGateFamilyRow {
    return {
        family: 'services',
        permissionFamily: 'services',
        read: true,
        act: 'ask',
        refusedBy: null,
        reason: null,
        fixRoute: null,
        tools: ['fleet_services_list', 'fleet_services_action'],
        planned: [],
        computers: [],
        ...over,
    };
}

function view(families: FleetToolsGateFamilyRow[]): FleetToolsGateView {
    return {
        agentId: 'a1',
        agentName: 'Nina',
        killSwitch: false,
        families,
        generatedAt: '2026-10-21T00:00:00Z',
    };
}

describe('agentFleetToolsRows', () => {
    it('shows the rung when the family may act', () => {
        const [row] = agentFleetToolsRows(view([family({})]));
        expect(row.act).toEqual({ kind: 'rung', rung: 'ask' });
        expect(row.read).toBe(true);
        expect(row.comingSoon).toBe(false);
    });

    it('names the refusing gate and links to where it is changed', () => {
        const [row] = agentFleetToolsRows(
            view([
                family({
                    act: 'off',
                    refusedBy: 'ladder',
                    reason: "'Change a computer' is Off for Nina — raise it on Nina's Safety tab",
                    fixRoute: 'agent-safety',
                }),
            ]),
        );
        expect(row.act).toEqual({ kind: 'refused', gate: 'ladder' });
        expect(row.fixHref).toBe('/agents/a1/settings');
    });

    it('lists the computers that refuse, each linking to its settings', () => {
        const [row] = agentFleetToolsRows(
            view([
                family({
                    computers: [
                        {
                            nodeId: 'n1',
                            name: 'build-01',
                            read: true,
                            act: true,
                            refusedBy: null,
                            hint: null,
                        },
                        {
                            nodeId: 'n2',
                            name: 'build-02',
                            read: false,
                            act: false,
                            refusedBy: 'audience',
                            hint: 'Only the owner of build-02 can do this.',
                        },
                    ],
                }),
            ]),
        );
        expect(
            row.computers.filter((computer) => !computer.allowed).map((computer) => computer.name),
        ).toEqual(['build-02']);
        expect(row.computers[1].href).toContain('/fleet/computers/n2');
    });

    it('marks a family with only planned tools as coming soon and drops empty families', () => {
        const rows = agentFleetToolsRows(
            view([
                family({
                    family: 'files',
                    tools: [],
                    planned: ['fleet_files_list'],
                    act: null,
                    read: false,
                }),
                family({ family: 'usage', tools: [], planned: [], act: null }),
            ]),
        );
        expect(rows.map((row) => row.family)).toEqual(['files']);
        expect(rows[0].comingSoon).toBe(true);
        expect(rows[0].act).toEqual({ kind: 'none' });
    });

    it('knows when there are no computers', () => {
        expect(agentFleetToolsHasComputers(view([family({})]))).toBe(false);
    });
});

describe('helpers', () => {
    it('maps every fix route', () => {
        expect(fleetToolsFixHref('fleet-settings', 'a1')).toBe('/settings/fleet');
        expect(fleetToolsFixHref('agent-capabilities', 'a1')).toBe('/agents/a1/capabilities');
        expect(fleetToolsFixHref('computer-settings', 'a1', 'n1')).toContain('/fleet/computers/n1');
        expect(fleetToolsFixHref(null, 'a1')).toBeNull();
    });

    it('camel-cases gate names for i18n', () => {
        expect(fleetToolsGateMessageKey('kill_switch')).toBe('killSwitch');
        expect(fleetToolsGateMessageKey('ladder')).toBe('ladder');
    });
});
