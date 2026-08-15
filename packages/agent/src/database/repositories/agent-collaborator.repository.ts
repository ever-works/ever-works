import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentCollaborator } from '../../entities/agent-collaborator.entity';

/**
 * Agent Collaborators — persistence for the per-agent sub-agent
 * delegation allow-list (see `agent-collaborator.entity.ts` for the
 * semantics; enforcement lives in the api-side delegation runner via
 * the pure `evaluateCollaboratorDelegation` contract helper).
 *
 * Every write is idempotent against the UNIQUE(agentId, collaboratorAgentId)
 * index: `upsert` updates the existing row's `enabled` flag instead of
 * inserting a duplicate, and `remove` deletes at most one row.
 */
@Injectable()
export class AgentCollaboratorRepository {
    constructor(
        @InjectRepository(AgentCollaborator)
        private readonly repository: Repository<AgentCollaborator>,
    ) {}

    /** Every configured rule for one parent agent (enabled AND disabled). */
    async listForAgent(agentId: string): Promise<AgentCollaborator[]> {
        return this.repository.find({ where: { agentId }, order: { createdAt: 'ASC' } });
    }

    /** Only the rules that currently permit a delegation. */
    async listEnabledForAgent(agentId: string): Promise<AgentCollaborator[]> {
        return this.repository.find({
            where: { agentId, enabled: true },
            order: { createdAt: 'ASC' },
        });
    }

    /**
     * Reverse lookup — "which agents list THIS one as a collaborator?".
     * Used by surfaces that answer "who can spawn me" (and handy for
     * cleanup audits); returns full rows so callers can read `enabled`.
     */
    async listAgentsAllowing(collaboratorAgentId: string): Promise<AgentCollaborator[]> {
        return this.repository.find({
            where: { collaboratorAgentId },
            order: { createdAt: 'ASC' },
        });
    }

    /**
     * Create-or-update the (agentId, collaboratorAgentId) rule.
     *
     * Service-layer guard for the entity's "never a self edge" rule: a
     * row saying "this agent may spawn itself" would be redundant at
     * best and confusing at worst — self-delegation is always allowed
     * implicitly and must not depend on a toggle.
     */
    async upsert(input: {
        userId: string;
        agentId: string;
        collaboratorAgentId: string;
        enabled: boolean;
        tenantId?: string | null;
        organizationId?: string | null;
    }): Promise<AgentCollaborator> {
        if (input.agentId === input.collaboratorAgentId) {
            throw new Error('An agent cannot be its own collaborator.');
        }
        const existing = await this.repository.findOne({
            where: { agentId: input.agentId, collaboratorAgentId: input.collaboratorAgentId },
        });
        if (existing) {
            existing.enabled = input.enabled;
            return this.repository.save(existing);
        }
        const row = this.repository.create({
            userId: input.userId,
            agentId: input.agentId,
            collaboratorAgentId: input.collaboratorAgentId,
            enabled: input.enabled,
            tenantId: input.tenantId ?? null,
            organizationId: input.organizationId ?? null,
        });
        return this.repository.save(row);
    }

    /** Idempotent delete. Returns whether a row actually existed. */
    async remove(agentId: string, collaboratorAgentId: string): Promise<boolean> {
        const result = await this.repository.delete({ agentId, collaboratorAgentId });
        return (result.affected ?? 0) > 0;
    }

    /** Cascade companion for hard agent deletes (either side of the edge). */
    async deleteAllForAgent(agentId: string): Promise<void> {
        await this.repository.delete({ agentId });
        await this.repository.delete({ collaboratorAgentId: agentId });
    }
}
