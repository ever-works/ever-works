import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { Agent } from '../../entities/agent.entity';
import { ModelPolicy } from '../../entities/model-policy.entity';

/**
 * The writes a policy change makes, bound to one transaction: either every
 * one of them commits or none does.
 */
export interface ModelPolicyWriteTransaction {
    save(entry: ModelPolicy): Promise<ModelPolicy>;
    deleteByScope(workspaceKey: string, scopeKey: string): Promise<boolean>;
    /**
     * Write an Agent's own provider/model pair — the Agent-scope primary
     * model lives on the `agents` row, not on the policy row.
     */
    setAgentModel(
        agentId: string,
        pair: { aiProviderId: string | null; modelId: string | null },
    ): Promise<void>;
}

/**
 * Model accounts (AW-16) — repository for `model_policies`, one row per scope
 * per workspace. Every read is keyed on the workspace.
 */
@Injectable()
export class ModelPolicyRepository {
    constructor(
        @InjectRepository(ModelPolicy)
        private readonly repository: Repository<ModelPolicy>,
    ) {}

    create(entry: Partial<ModelPolicy>): ModelPolicy {
        return this.repository.create(entry);
    }

    async save(entry: ModelPolicy): Promise<ModelPolicy> {
        return this.repository.save(entry);
    }

    /**
     * Run a policy change's writes — the policy row and, for an Agent, the
     * Agent's own model pair — in one transaction, so a failed policy write
     * never leaves the Agent on a new primary model with its old fallbacks,
     * effort or timeout (or the reverse).
     */
    async inTransaction<T>(work: (tx: ModelPolicyWriteTransaction) => Promise<T>): Promise<T> {
        return this.repository.manager.transaction(async (manager: EntityManager) => {
            const policies = manager.getRepository(ModelPolicy);
            const agents = manager.getRepository(Agent);
            return work({
                save: (entry) => policies.save(entry),
                deleteByScope: async (workspaceKey, scopeKey) => {
                    const result = await policies.delete({ workspaceKey, scopeKey });
                    return (result.affected ?? 0) > 0;
                },
                setAgentModel: async (agentId, pair) => {
                    await agents.update({ id: agentId }, pair);
                },
            });
        });
    }

    async findByScope(workspaceKey: string, scopeKey: string): Promise<ModelPolicy | null> {
        return this.repository.findOne({ where: { workspaceKey, scopeKey } });
    }

    /** Every stored policy among `scopeKeys` for one workspace, in one read. */
    async findByScopes(workspaceKey: string, scopeKeys: readonly string[]): Promise<ModelPolicy[]> {
        if (scopeKeys.length === 0) return [];
        return this.repository.find({ where: { workspaceKey, scopeKey: In([...scopeKeys]) } });
    }

    async deleteByScope(workspaceKey: string, scopeKey: string): Promise<boolean> {
        const result = await this.repository.delete({ workspaceKey, scopeKey });
        return (result.affected ?? 0) > 0;
    }

    /** True when any policy exists anywhere — the call path's cheapest "is this feature in use" probe. */
    async anyExist(): Promise<boolean> {
        const row = await this.repository.findOne({ where: {}, select: { id: true } });
        return !!row;
    }
}
