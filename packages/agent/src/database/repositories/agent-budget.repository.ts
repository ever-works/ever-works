import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentBudget, AgentBudgetIntervalUnit } from '../../entities/agent-budget.entity';

@Injectable()
export class AgentBudgetRepository {
    constructor(
        @InjectRepository(AgentBudget)
        private readonly repository: Repository<AgentBudget>,
    ) {}

    async findByAgentId(agentId: string): Promise<AgentBudget | null> {
        return this.repository.findOne({ where: { agentId } });
    }

    async upsert(agentId: string, data: Partial<AgentBudget>): Promise<AgentBudget> {
        await this.repository.upsert({ agentId, ...data }, ['agentId']);
        const row = await this.findByAgentId(agentId);
        if (!row) {
            throw new Error(`AgentBudget upsert returned null for agentId=${agentId}`);
        }
        return row;
    }

    async deleteByAgentId(agentId: string): Promise<void> {
        await this.repository.delete({ agentId });
    }

    /**
     * Convenience for tests + callers that want a partial summary
     * without going through `BudgetService.summarizeForOwner`. The
     * actual spend aggregation lives in the BudgetService (Phase 7
     * T34a — multi-interval aggregator).
     */
    async summary(agentId: string): Promise<{
        intervalUnit: AgentBudgetIntervalUnit;
        capCents: number;
        currency: string;
        allowOverage: boolean;
        intervalAnchor: Date | null;
    } | null> {
        const row = await this.findByAgentId(agentId);
        if (!row) {
            return null;
        }
        return {
            intervalUnit: row.intervalUnit,
            capCents: row.capCents,
            currency: row.currency,
            allowOverage: row.allowOverage,
            intervalAnchor: row.intervalAnchor ?? null,
        };
    }
}
