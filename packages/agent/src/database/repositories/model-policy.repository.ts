import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ModelPolicy } from '../../entities/model-policy.entity';

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
