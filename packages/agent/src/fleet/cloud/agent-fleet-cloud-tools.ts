import {
    isFleetCloudName,
    isFleetCloudPowerAction,
    normalizeFleetCloudSoftware,
    type FleetLinkError,
} from '@ever-works/contracts';
import type { TaskToolDescriptor } from '../../tasks-domain/agent-task-tools';
import type { AgentProposalToolSource } from '../../agents/agent-domain-tool-sources';
import { readFleetMachineError } from '../machine/fleet-machine.errors';
import type { FleetCloudService } from './fleet-cloud.service';

/**
 * Cloud computers (FL-17, plan §9, spec FR-33, FR-34, S9) — the Agent tools,
 * named after the API segment (CONTRACTS §11.3): `fleet_cloud_list`,
 * `fleet_cloud_options`, `fleet_cloud_usage` (read-only), `fleet_cloud_create`,
 * `fleet_cloud_power`, `fleet_cloud_destroy` (destructive).
 *
 * Every call runs the SAME chain a person's click runs (`FleetCloudService`)
 * with the Agent as the caller (`agent:<id>`): the kill switch, the request
 * (`acknowledgedPriceCents` is REQUIRED and checked against the provider's
 * current price — a mismatch is `invalid` with the current price, FR-34), the
 * `machines` audience. A create, a power change and a destroy spend or stop
 * the owner's money, so they are never run on the Agent's say-so: once the
 * chain has accepted everything but the confirmation, the act is HELD as an
 * Approval in the owner's My Decisions (CONTRACTS R-33) titled with the
 * confirmation's own text — "Creates nyc-ops, a 2 CPU · 4 GB cloud computer at
 * <provider> (nyc3) for about $24/month ($0.036/hour), billed to your
 * <provider> account until destroyed." — and the call answers
 * `{ held: true, decisionId }`. A person's approval runs it
 * (`FleetCloudProposalListener`), every gate again.
 *
 * Unbound approval queue: a held act fails CLOSED — refused, never run.
 */

/** The platform-written `payload.kind` of a held cloud-computer act. */
export const FLEET_CLOUD_ACTION_PROPOSAL_KIND = 'fleet-cloud-action' as const;

/** Tool annotations (CONTRACTS §11.3) — what FL-19's catalogue and MCP read. */
export const FLEET_CLOUD_TOOL_ANNOTATIONS: Readonly<
    Record<string, { readOnly?: true; destructive?: boolean; confirmationClass?: string }>
> = {
    fleet_cloud_list: { readOnly: true },
    fleet_cloud_options: { readOnly: true },
    fleet_cloud_usage: { readOnly: true },
    fleet_cloud_create: { destructive: true, confirmationClass: 'confirm' },
    fleet_cloud_power: { destructive: true, confirmationClass: 'confirm' },
    fleet_cloud_destroy: { destructive: true, confirmationClass: 'confirm-destructive' },
};

/** What a held act stores so a person's approval can run exactly it (no model-authored free text). */
export interface FleetCloudActionProposalPayload {
    kind: typeof FLEET_CLOUD_ACTION_PROPOSAL_KIND;
    verb: 'create' | 'power' | 'destroy';
    agentId: string;
    /** power / destroy: the cloud computer. */
    nodeId?: string;
    /** create: providerPluginId, name, regionId, sizeId, software, acknowledgedPriceCents. power: action. destroy: name. */
    args: Record<string, unknown>;
}

type ToolError = { error: FleetLinkError };

function toolError(error: unknown): ToolError {
    const known = readFleetMachineError(error);
    return {
        error: known ?? { code: 'internal', hint: error instanceof Error ? error.message.slice(0, 200) : 'failed' },
    };
}

function invalid(field: string, hint: string): ToolError {
    return { error: { code: 'invalid', hint, details: { field } } };
}

export function buildFleetCloudTools(args: {
    /** The Agent's owner — the scope every call runs under. */
    userId: string;
    agentId: string;
    runId: string | null;
    service: Pick<FleetCloudService, 'list' | 'options' | 'usage' | 'create' | 'power' | 'destroy'>;
    /** The approval seam for held acts; null = held acts are refused (fail closed). */
    proposals: AgentProposalToolSource | null;
}): TaskToolDescriptor[] {
    const caller = { kind: 'agent' as const, agentId: args.agentId, ownerUserId: args.userId };
    const out: TaskToolDescriptor[] = [];

    const hold = async (payload: Omit<FleetCloudActionProposalPayload, 'kind' | 'agentId'>, title: string) => {
        if (!args.proposals) {
            return {
                error: {
                    code: 'confirmation_required' as const,
                    hint: 'this act spends or stops the owner’s money and no approval queue is available; ask the owner to do it',
                },
            };
        }
        const full: FleetCloudActionProposalPayload = {
            kind: FLEET_CLOUD_ACTION_PROPOSAL_KIND,
            agentId: args.agentId,
            ...payload,
        };
        const subject = JSON.stringify([full.verb, full.nodeId ?? null, full.args]);
        const proposal = await args.proposals.propose(args.userId, {
            agentId: args.agentId,
            runId: args.runId,
            title: title.slice(0, 200),
            payload: { ...full },
            subjectKey: `fleet-cloud:${subject.slice(0, 180)}`,
        });
        return {
            held: true,
            proposalId: proposal.id,
            decisionId: proposal.id,
            status: proposal.status,
            hint: 'held for the owner’s approval in My Decisions; it runs when they approve it',
        };
    };

    /** The confirmation_required refusal's text (the Decision text for a create), or null for any other error. */
    const confirmationText = (error: unknown): string | null => {
        const known = readFleetMachineError(error);
        if (known?.code !== 'confirmation_required') return null;
        const details = known.details ?? {};
        if (typeof details.decision === 'string') return details.decision;
        return typeof details.summary === 'string' ? details.summary : '';
    };

    out.push({
        name: 'fleet_cloud_list',
        description:
            'List the owner’s cloud computers (machines Ever Works created at a cloud provider) with provider, region, size, power state, hourly rate and cost so far, the usage totals (estimates from list prices), and the connected providers (pluginId for fleet_cloud_options). Read-only.',
        parameters: { type: 'object', properties: {} },
        invoke: async () => {
            try {
                return await args.service.list(caller);
            } catch (error) {
                return toolError(error);
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_cloud_options',
        description:
            'Regions, sizes with their CURRENT monthly and hourly list prices, software presets and the connected account for one cloud provider (providerPluginId from fleet_cloud_list). Read the price here before fleet_cloud_create. Read-only.',
        parameters: {
            type: 'object',
            properties: {
                providerPluginId: { type: 'string', description: 'The machine-provider plugin id.' },
            },
            required: ['providerPluginId'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { providerPluginId?: unknown };
            if (typeof a.providerPluginId !== 'string' || !a.providerPluginId) {
                return invalid('providerPluginId', 'providerPluginId is required (see fleet_cloud_list)');
            }
            try {
                return await args.service.options(caller, a.providerPluginId);
            } catch (error) {
                return toolError(error);
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_cloud_usage',
        description:
            'What the owner’s cloud computers cost: per hour now, this month so far and projected for the month — estimates from the provider’s list prices (the bill may differ). With nodeId, one machine. Read-only.',
        parameters: {
            type: 'object',
            properties: { nodeId: { type: 'string', description: 'Optional: one cloud computer (Fleet node id).' } },
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as { nodeId?: unknown };
            try {
                return await args.service.usage(caller, typeof a.nodeId === 'string' && a.nodeId ? a.nodeId : null);
            } catch (error) {
                return toolError(error);
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_cloud_create',
        description:
            'Create a cloud computer at a provider on the owner’s own account. It bills the owner from creation until destroyed (also while powered off where the provider does). Requires acknowledgedPriceCents = the monthly price from fleet_cloud_options; a stale price is refused with the current one. Never runs on the Agent’s say-so: once checked, it is held for the owner’s approval with the exact size and price.',
        parameters: {
            type: 'object',
            properties: {
                providerPluginId: { type: 'string', description: 'The machine-provider plugin id.' },
                name: { type: 'string', description: '2–39 lower-case letters, digits and hyphens.' },
                regionId: { type: 'string', description: 'A region id from fleet_cloud_options.' },
                sizeId: { type: 'string', description: 'A size id from fleet_cloud_options.' },
                acknowledgedPriceCents: {
                    type: 'number',
                    description: 'The size’s monthly price in cents, exactly as fleet_cloud_options reported it.',
                },
                software: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'docker, node, claude-code, codex (default: all four).',
                },
            },
            required: ['providerPluginId', 'name', 'regionId', 'sizeId', 'acknowledgedPriceCents'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as Record<string, unknown>;
            if (typeof a.providerPluginId !== 'string' || !a.providerPluginId) {
                return invalid('providerPluginId', 'providerPluginId is required');
            }
            if (!isFleetCloudName(a.name)) {
                return invalid('name', 'the name must be 2–39 lower-case letters, digits and hyphens');
            }
            if (typeof a.regionId !== 'string' || !a.regionId) return invalid('regionId', 'regionId is required');
            if (typeof a.sizeId !== 'string' || !a.sizeId) return invalid('sizeId', 'sizeId is required');
            if (typeof a.acknowledgedPriceCents !== 'number' || !Number.isFinite(a.acknowledgedPriceCents)) {
                return invalid('acknowledgedPriceCents', 'acknowledgedPriceCents (the monthly price you were shown) is required');
            }
            const input = {
                providerPluginId: a.providerPluginId,
                name: a.name,
                regionId: a.regionId,
                sizeId: a.sizeId,
                acknowledgedPriceCents: a.acknowledgedPriceCents,
                software: normalizeFleetCloudSoftware(a.software),
            };
            try {
                // Without `confirm`: the whole chain runs (price, limit, kill switch) and answers with the text.
                await args.service.create(caller, { ...input, fields: {} });
                return { error: { code: 'internal' as const, hint: 'the create was not confirmed' } };
            } catch (error) {
                const text = confirmationText(error);
                if (text === null) return toolError(error);
                return hold({ verb: 'create', args: { ...input } }, text || `Create ${input.name}`);
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_cloud_power',
        description:
            'Power one of the owner’s cloud computers on or off. Held for the owner’s approval. Powering off keeps the machine (and, at most providers, the bill); sessions on it end.',
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The cloud computer (Fleet node id).' },
                action: { type: 'string', description: 'on or off.' },
            },
            required: ['nodeId', 'action'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as Record<string, unknown>;
            if (typeof a.nodeId !== 'string' || !a.nodeId) return invalid('nodeId', 'nodeId is required');
            if (!isFleetCloudPowerAction(a.action)) return invalid('action', 'action must be on or off');
            try {
                await args.service.power(caller, a.nodeId, a.action, {});
                return { error: { code: 'internal' as const, hint: 'the power change was not confirmed' } };
            } catch (error) {
                const text = confirmationText(error);
                if (text === null) return toolError(error);
                return hold(
                    { verb: 'power', nodeId: a.nodeId, args: { action: a.action } },
                    text || `Power ${a.action} a cloud computer`,
                );
            }
        },
    } as TaskToolDescriptor);

    out.push({
        name: 'fleet_cloud_destroy',
        description:
            'Destroy one of the owner’s cloud computers: the machine and its disk are deleted at the provider (billing stops), then its Fleet registration (job history is kept). Irreversible, so it is always held for the owner’s approval with the cost so far; refused while a Run or a session is live on it.',
        parameters: {
            type: 'object',
            properties: {
                nodeId: { type: 'string', description: 'The cloud computer (Fleet node id).' },
                name: { type: 'string', description: 'The cloud computer’s exact name.' },
            },
            required: ['nodeId', 'name'],
        },
        invoke: async (raw) => {
            const a = (raw ?? {}) as Record<string, unknown>;
            if (typeof a.nodeId !== 'string' || !a.nodeId) return invalid('nodeId', 'nodeId is required');
            if (!isFleetCloudName(a.name)) return invalid('name', 'the name is not a cloud computer name');
            try {
                await args.service.destroy(caller, a.nodeId, {});
                return { error: { code: 'internal' as const, hint: 'the destroy was not confirmed' } };
            } catch (error) {
                const text = confirmationText(error);
                if (text === null) return toolError(error);
                return hold({ verb: 'destroy', nodeId: a.nodeId, args: { name: a.name } }, text || `Destroy ${a.name}`);
            }
        },
    } as TaskToolDescriptor);

    return out;
}
