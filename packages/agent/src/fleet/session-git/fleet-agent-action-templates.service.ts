import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
    FLEET_SESSION_ACTION_DEFAULTS,
    FLEET_SESSION_ACTION_IDS,
    fleetSessionBranchPrefix,
    isFleetSessionActionId,
    type FleetAgentActionTemplates,
    type FleetAgentActionTemplatesUpdate,
    type FleetSessionActionId,
} from '@ever-works/contracts';
import { AgentRepository } from '../../database/repositories/agent.repository';
import { AgentFileService } from '../../agents/agent-file.service';
import { getOptionalProvider } from '../../utils/optional-provider.util';
import { fleetSessionError } from '../sessions/fleet-session.errors';
import { readAgentFleetBlock, writeAgentFleetBlock, type AgentFleetBlock } from './agent-fleet-block';

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Session git & actions (FL-06 P3, spec FR-27, S12, §5.7) — the Agent
 * instructions editor's **Fleet actions** section: the seven action
 * templates and the branch prefix, each beside the default it overrides,
 * read from and written into the Agent's own `agent.yml` (`fleet` block) —
 * nothing new is stored. The write goes through the Agent file service (its
 * ownership check, secret scan, size cap, etag and activity record), so it is
 * exactly a save of `agent.yml`; the rest of the file is kept.
 */
@Injectable()
export class FleetAgentActionTemplatesService {
    constructor(
        private readonly agents: AgentRepository,
        @Optional() private readonly moduleRef?: ModuleRef,
    ) {}

    /** `GET /api/fleet/agents/:agentId/action-templates`. */
    async read(agentId: string, userId: string): Promise<FleetAgentActionTemplates> {
        const agent = await this.owned(agentId, userId);
        const { block, error } = readAgentFleetBlock(agent.agentYml ?? null);
        return this.view(agent, block, error ? `${error.field}: ${error.message}` : null);
    }

    /** `PUT /api/fleet/agents/:agentId/action-templates` — a template left empty falls back to the default. */
    async write(
        agentId: string,
        userId: string,
        update: FleetAgentActionTemplatesUpdate,
    ): Promise<FleetAgentActionTemplates> {
        const agent = await this.owned(agentId, userId);
        const current = readAgentFleetBlock(agent.agentYml ?? null).block;
        const next: AgentFleetBlock = { branchPrefix: current.branchPrefix, actions: { ...current.actions } };
        if (update.branchPrefix !== undefined) next.branchPrefix = update.branchPrefix?.trim() || null;
        if (update.actions && typeof update.actions === 'object') {
            for (const [id, value] of Object.entries(update.actions)) {
                if (!isFleetSessionActionId(id)) {
                    throw fleetSessionError('invalid', `"${id}" is not an action`, { field: `actions.${id}` });
                }
                const text = typeof value === 'string' ? value : '';
                // The default text itself is not an override (the file stays clean).
                if (!text.trim() || text.trim() === FLEET_SESSION_ACTION_DEFAULTS[id].trim()) delete next.actions[id];
                else next.actions[id] = text;
            }
        }
        const body = writeAgentFleetBlock(agent.agentYml ?? null, next);
        if (body === null) {
            throw fleetSessionError('invalid', 'agent.yml is not valid YAML; fix it in the editor first', {
                field: 'agent.yml',
            });
        }
        const files = this.moduleRef ? getOptionalProvider<AgentFileService>(this.moduleRef, AgentFileService) : undefined;
        if (!files) throw fleetSessionError('internal', 'Agent files cannot be saved in this deployment');
        const { newHash } = await files.write({
            userId,
            agentId: agent.id,
            name: 'agent.yml',
            body,
            ...(update.expectedHash !== undefined ? { expectedHash: update.expectedHash } : {}),
        });
        return { ...this.view({ ...agent, agentYml: body }, next, null), agentYml: body, hash: newHash };
    }

    private view(
        agent: { id: string; name: string; slug: string; agentYml?: string | null; contentHash?: string | null },
        block: AgentFleetBlock,
        error: string | null,
    ): FleetAgentActionTemplates {
        const actions = {} as FleetAgentActionTemplates['actions'];
        for (const id of FLEET_SESSION_ACTION_IDS) {
            actions[id as FleetSessionActionId] = {
                value: block.actions[id] ?? null,
                default: FLEET_SESSION_ACTION_DEFAULTS[id],
            };
        }
        return {
            agentId: agent.id,
            agentName: agent.name,
            branchPrefix: { value: block.branchPrefix, default: fleetSessionBranchPrefix(agent.slug || agent.name) },
            actions,
            error,
            agentYml: agent.agentYml ?? '',
            hash: agent.contentHash ?? '',
        };
    }

    private async owned(agentId: string, userId: string) {
        const agent = typeof agentId === 'string' && UUID.test(agentId) ? await this.agents.findById(agentId) : null;
        if (!agent || agent.userId !== userId) throw fleetSessionError('not_found', 'no such Agent');
        return agent;
    }
}
