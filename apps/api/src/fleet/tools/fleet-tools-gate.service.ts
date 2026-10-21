import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { config } from '@ever-works/agent/config';
import { AgentRepository } from '@ever-works/agent/database';
import {
    FleetKillSwitchService,
    FleetService,
    decideFleetToolCall,
    type FleetToolGateComputer,
    type FleetToolGateDecision,
} from '@ever-works/agent/fleet';
import { AutonomyGrantService, WorkspacePauseService, ladderEntry } from '@ever-works/agent/safety';
import { TOOL_GRANT_ENFORCER, type ToolGrantEnforcer } from '@ever-works/agent/policy';
import {
    FLEET_TOOL_CATALOGUE,
    FLEET_TOOL_FAMILIES,
    FLEET_TOOL_FAMILY_CONSENT,
    fleetFamilyAllows,
    isLadderedCategory,
    matchesAnyToolPattern,
    moreRestrictiveCategory,
    type ActionCategory,
    type FleetActionFamily,
    type FleetNodeView,
    type FleetToolCatalogueEntry,
    type FleetToolFamily,
    type FleetToolFlag,
    type FleetToolGateName,
    type FleetToolsGateActRung,
    type FleetToolsGateComputer,
    type FleetToolsGateFamilyRow,
    type FleetToolsGateView,
    type FleetViewerRole,
    type ResolvedLadder,
    type ToolGrantMatrix,
    type TrustRung,
} from '@ever-works/contracts';

/** Is a catalogue row's deployment flag on? Flags this build does not know read as off. */
export function fleetToolFlagOn(flag: FleetToolFlag): boolean {
    switch (flag) {
        case 'FLEET_ENABLED':
            return config.fleet.isEnabled();
        case 'FLEET_NODE_LINK_ENABLED':
            return config.fleet.isNodeLinkEnabled();
        case 'FLEET_HEALTH_HISTORY_ENABLED':
            return config.fleet.isHealthHistoryEnabled();
        case 'FLEET_SESSIONS_ENABLED':
            return config.fleet.isSessionsEnabled();
        case 'FLEET_MACHINE_FACTS_ENABLED':
            return config.fleet.isMachineFactsEnabled();
        case 'FLEET_PORT_TUNNEL_ENABLED':
            return config.fleet.isPortTunnelEnabled();
        case 'FLEET_COMMANDS_ENABLED':
            return config.fleet.isCommandsEnabled();
        case 'FLEET_CHECKOUTS_ENABLED':
            return config.fleet.isCheckoutsEnabled();
        default:
            // FLEET_DESKTOP / VIRTUAL / CLOUD / ACTIONS_RUNNERS / USAGE_SCAN: their epics
            // add the getter with their family; until then the rows are `planned` anyway.
            return process.env[flag] === 'true';
    }
}

/** Where each refusing gate is changed (spec FR-24, §5.1). */
const FIX_ROUTE: Readonly<Record<FleetToolGateName, FleetToolsGateFamilyRow['fixRoute']>> = {
    kill_switch: 'fleet-settings',
    workspace_pause: 'agent-safety',
    agent_pause: 'agent-safety',
    grants: 'agent-capabilities',
    ladder: 'agent-safety',
    caps: 'agent-safety',
    audience: 'computer-settings',
    consent: 'computer-settings',
};

/** `allow` / `deny` patterns → may this tool name be called (deny wins, then allow). */
function grantAllows(matrix: ToolGrantMatrix | null, toolName: string): boolean {
    if (!matrix) return true;
    if (matchesAnyToolPattern(matrix.deny ?? [], toolName)) return false;
    return matchesAnyToolPattern(matrix.allow ?? ['*'], toolName);
}

/** The rung in force for a category: an unenforced shipped default behaves as Auto (AW-24 P1). */
function rungFor(ladder: ResolvedLadder | null, category: ActionCategory | undefined): TrustRung | null {
    if (!ladder || !category || !isLadderedCategory(category)) return null;
    const entry = ladderEntry(ladder, category);
    if (!entry || !entry.enforced) return 'auto';
    return entry.rung;
}

/** The strictest category among a family's acts (the one its act rung is read for). */
function strictestCategory(acts: readonly FleetToolCatalogueEntry[]): ActionCategory | undefined {
    let out: ActionCategory | undefined;
    for (const act of acts) {
        if (!act.category) continue;
        out = out ? moreRestrictiveCategory(out, act.category) : act.category;
    }
    return out;
}

/**
 * FL-19 — `GET /api/fleet/tools/gate?agentId=` (spec FR-24, plan §5): what one
 * Agent may read and do in each fleet tool family, and when not, which gate
 * refuses and where to change it. Feeds the Agent's Capabilities "Fleet
 * tools" block.
 *
 * It reads the same facts the run-time enforcement reads — the kill switch,
 * the Workspace pause, the Agent's status, its tool-grant matrix, its trust
 * ladder, and each visible computer's control policy and consents — and puts
 * them through `decideFleetToolCall`, the published rule. Every input degrades
 * on its own (an unbound grant enforcer is the permissive platform default, an
 * unreadable ladder resolves safe-mode Ask, exactly as the gate would).
 */
@Injectable()
export class FleetToolsGateService {
    private readonly logger = new Logger(FleetToolsGateService.name);

    constructor(
        private readonly agents: AgentRepository,
        private readonly fleet: FleetService,
        private readonly killSwitch: FleetKillSwitchService,
        @Optional() private readonly autonomy?: AutonomyGrantService,
        @Optional() private readonly pauses?: WorkspacePauseService,
        @Optional() @Inject(TOOL_GRANT_ENFORCER) private readonly grants?: ToolGrantEnforcer,
    ) {}

    async gateFor(userId: string, agentId: string): Promise<FleetToolsGateView> {
        const agent = await this.agents.findByIdAndUser(agentId, userId);
        if (!agent) throw new NotFoundException({ error: { code: 'not_found', hint: 'no such Agent' } });

        const tenantId = (agent as { tenantId?: string | null }).tenantId ?? null;
        const organizationId = (agent as { organizationId?: string | null }).organizationId ?? null;
        const workId = (agent as { workId?: string | null }).workId ?? null;

        const [killSwitch, pause, ladder, matrix, nodes] = await Promise.all([
            this.killSwitch
                .publicState()
                .then((state) => state.stopped)
                .catch(() => false),
            this.pauses
                ? this.pauses
                      .state(tenantId ? { tenantId, organizationId } : null)
                      .then((state) => state.paused)
                      .catch(() => false)
                : Promise.resolve(false),
            this.autonomy
                ? this.autonomy
                      .resolve(userId, { workspaceScopeId: organizationId ?? tenantId ?? userId, agentId })
                      .catch(() => null)
                : Promise.resolve(null),
            this.grants
                ? this.grants
                      .resolve({ userId, agentId, workId, organizationId, tenantId })
                      .then((resolved) => resolved.matrix)
                      .catch((error) => {
                          this.logger.warn(`fleet tools gate: grants unreadable (${String(error)})`);
                          return null;
                      })
                : Promise.resolve(null),
            this.fleet.listVisibleForUser(userId, { includeClusters: false }).catch(() => [] as FleetNodeView[]),
        ]);

        const agentName = agent.name ?? 'This Agent';
        const agentPaused = String(agent.status) === 'paused';
        const persisted = nodes.filter((node) => node.persisted);

        const families: FleetToolsGateFamilyRow[] = FLEET_TOOL_FAMILIES.map((family) =>
            this.familyRow(family, {
                agentName,
                killSwitch,
                workspacePaused: pause,
                agentPaused,
                ladder,
                matrix,
                nodes: persisted,
            }),
        );

        return {
            agentId: agent.id,
            agentName,
            killSwitch,
            families,
            generatedAt: new Date().toISOString(),
        };
    }

    private familyRow(
        family: FleetToolFamily,
        facts: {
            agentName: string;
            killSwitch: boolean;
            workspacePaused: boolean;
            agentPaused: boolean;
            ladder: ResolvedLadder | null;
            matrix: ToolGrantMatrix | null;
            nodes: readonly FleetNodeView[];
        },
    ): FleetToolsGateFamilyRow {
        const rows = FLEET_TOOL_CATALOGUE.filter((entry) => entry.family === family);
        const live = rows.filter((entry) => entry.status === 'live' && fleetToolFlagOn(entry.flag));
        const planned = rows.filter((entry) => entry.status === 'planned').map((entry) => entry.name);
        const reads = live.filter((entry) => entry.readOnly);
        const acts = live.filter((entry) => !entry.readOnly);

        const read = reads.some((entry) => grantAllows(facts.matrix, entry.name));
        // The family's acts are checked for the strictest permission family among them
        // (`services` for services, `machines` for wake) and its strictest category.
        const representative = acts.find((entry) => grantAllows(facts.matrix, entry.name)) ?? acts[0];
        const category = strictestCategory(acts);
        const permissionFamily: FleetActionFamily =
            representative?.permissionFamily ?? reads[0]?.permissionFamily ?? rows[0]?.permissionFamily ?? 'view';

        let act: FleetToolsGateActRung | null = null;
        let refusedBy: FleetToolGateName | null = null;
        let reason: string | null = null;
        if (representative) {
            const rung = rungFor(facts.ladder, category);
            const decision = decideFleetToolCall({
                tool: { ...representative, category },
                agentName: facts.agentName,
                killSwitch: facts.killSwitch,
                workspacePaused: facts.workspacePaused,
                agentPaused: facts.agentPaused,
                grant: {
                    allowed: acts.some((entry) => grantAllows(facts.matrix, entry.name)),
                    deniedAtScope: 'Agent',
                },
                rung,
            });
            act = (rung ?? 'auto') as FleetToolsGateActRung;
            if (decision.outcome === 'refused') {
                refusedBy = decision.gate;
                reason = decision.error?.hint ?? null;
                if (decision.gate === 'ladder') act = 'off';
            }
        }

        const computers: FleetToolsGateComputer[] = facts.nodes.map((node) =>
            this.computerRow(node, permissionFamily, {
                agentName: facts.agentName,
                read,
                act: act !== null && act !== 'off' && refusedBy === null,
                representative,
            }),
        );

        return {
            family,
            permissionFamily,
            read,
            act,
            refusedBy,
            reason,
            fixRoute: refusedBy ? FIX_ROUTE[refusedBy] : null,
            tools: live.map((entry) => entry.name),
            planned,
            computers,
        };
    }

    private computerRow(
        node: FleetNodeView,
        family: FleetActionFamily,
        facts: {
            agentName: string;
            read: boolean;
            act: boolean;
            representative: FleetToolCatalogueEntry | undefined;
        },
    ): FleetToolsGateComputer {
        const role: FleetViewerRole = node.viewerRole ?? 'owner';
        const gateComputer: FleetToolGateComputer = {
            name: node.name,
            role,
            viewAllows: true,
            familyAllows: fleetFamilyAllows(node, role, family),
            consentRequired: FLEET_TOOL_FAMILY_CONSENT[family],
            consents: node.consents ?? null,
        };
        const decision: FleetToolGateDecision = decideFleetToolCall({
            tool: { name: facts.representative?.name ?? 'fleet_status', readOnly: true, permissionFamily: family },
            agentName: facts.agentName,
            killSwitch: false,
            workspacePaused: false,
            agentPaused: false,
            grant: { allowed: true },
            rung: null,
            computer: gateComputer,
        });
        const allowed = decision.outcome !== 'refused';
        return {
            nodeId: node.id,
            name: node.name,
            read: facts.read && allowed,
            act: facts.act && allowed,
            refusedBy: decision.gate === 'audience' || decision.gate === 'consent' ? decision.gate : null,
            hint: decision.error?.hint ?? null,
        };
    }
}
