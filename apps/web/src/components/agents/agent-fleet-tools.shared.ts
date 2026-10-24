import type {
    FleetToolFamily,
    FleetToolsGateFamilyRow,
    FleetToolsGateView,
} from '@ever-works/contracts';
import { ROUTES } from '@/lib/constants';

/**
 * Agent › Capabilities › Fleet tools (FL-19, spec FR-24, §5.1) — the pure half.
 *
 * The block answers one question per tool family: may this Agent READ there,
 * may it ACT there (and at which rung of its trust ladder), and when it may
 * not, WHICH gate refuses and where that is changed. The facts come composed
 * from `GET /api/fleet/tools/gate?agentId=`; this file only decides what a row
 * shows, so the layout file stays layout.
 */

/** What the page could read: the view, nothing (Fleet off — the block hides), or an error. */
export type AgentFleetToolsData = { kind: 'ready'; view: FleetToolsGateView } | { kind: 'error' } | null;

export type AgentFleetToolsActCell =
    | { kind: 'none' }
    | { kind: 'rung'; rung: 'auto' | 'ask' | 'draft' }
    | { kind: 'refused'; gate: string };

export interface AgentFleetToolsRow {
    family: FleetToolFamily;
    read: boolean;
    act: AgentFleetToolsActCell;
    /** The §5.5 sentence of the refusing gate, when one refuses. */
    reason: string | null;
    /** Where to change it (an app route), when a gate refuses. */
    fixHref: string | null;
    /** Per-computer refusals (`build-02 ✗ owner allows only owner`). */
    computers: Array<{ nodeId: string; name: string; allowed: boolean; hint: string | null; href: string }>;
    /** Only planned tools: the family has not landed on this deployment yet. */
    comingSoon: boolean;
}

/** The app route for a refusal's fix (spec §5.1: Safety, Capabilities, Settings → Fleet, the computer's Settings). */
export function fleetToolsFixHref(
    fixRoute: FleetToolsGateFamilyRow['fixRoute'],
    agentId: string,
    nodeId?: string | null,
): string | null {
    switch (fixRoute) {
        case 'agent-safety':
            return ROUTES.DASHBOARD_AGENT_SETTINGS(agentId);
        case 'agent-capabilities':
            return ROUTES.DASHBOARD_AGENT_CAPABILITIES(agentId);
        case 'fleet-settings':
            return ROUTES.DASHBOARD_SETTINGS_FLEET;
        case 'computer-settings':
            return nodeId ? ROUTES.DASHBOARD_FLEET_COMPUTER(nodeId, 'settings') : ROUTES.DASHBOARD_FLEET;
        default:
            return null;
    }
}

/** One display row per family that has at least one tool (live or planned), in catalogue order. */
export function agentFleetToolsRows(view: FleetToolsGateView): AgentFleetToolsRow[] {
    return view.families
        .filter((family) => family.tools.length > 0 || family.planned.length > 0)
        .map((family) => {
            const comingSoon = family.tools.length === 0;
            let act: AgentFleetToolsActCell = { kind: 'none' };
            if (family.refusedBy) act = { kind: 'refused', gate: family.refusedBy };
            else if (family.act && family.act !== 'off') act = { kind: 'rung', rung: family.act };
            else if (family.act === 'off') act = { kind: 'refused', gate: 'ladder' };
            return {
                family: family.family,
                read: family.read,
                act,
                reason: family.reason,
                fixHref: fleetToolsFixHref(family.fixRoute, view.agentId),
                computers: family.computers.map((computer) => ({
                    nodeId: computer.nodeId,
                    name: computer.name,
                    allowed: computer.refusedBy === null,
                    hint: computer.hint,
                    href: ROUTES.DASHBOARD_FLEET_COMPUTER(computer.nodeId, 'settings'),
                })),
                comingSoon,
            };
        });
}

/** The i18n leaf of a gate (`fleet.tools.capabilities.gates.*` keys are camelCase). */
export function fleetToolsGateMessageKey(gate: string): string {
    return gate.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/** Families with any live tool — the "You have no computers yet" empty state checks computers separately. */
export function agentFleetToolsHasComputers(view: FleetToolsGateView): boolean {
    return view.families.some((family) => family.computers.length > 0);
}
