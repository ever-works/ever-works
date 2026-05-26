import { getMetadataArgsStorage } from 'typeorm';
import { AgentBudget } from '../agent-budget.entity';
import { AgentMembership } from '../agent-membership.entity';
import { BudgetOwnerType } from '../_types';

describe('AgentBudget entity', () => {
    const storage = getMetadataArgsStorage();
    const table = storage.tables.find((t) => t.target === AgentBudget);
    const columns = storage.columns.filter((c) => c.target === AgentBudget);
    const indices = storage.indices.filter((i) => i.target === AgentBudget);
    const columnNames = columns.map((c) => c.propertyName);

    it('maps to `agent_budgets`', () => {
        expect(table?.name).toBe('agent_budgets');
    });

    it('declares the all-5-intervalUnit shape (N6 override — round 9)', () => {
        expect(columnNames).toEqual(
            expect.arrayContaining([
                'agentId',
                'intervalUnit',
                'intervalAnchor',
                'capCents',
                'currency',
                'allowOverage',
            ]),
        );
    });

    it('UNIQUE on agentId (one budget per Agent)', () => {
        const uq = indices.find((i) => i.name === 'uq_agent_budgets_agentId');
        expect(uq).toBeDefined();
        expect(uq?.unique).toBe(true);
        expect(uq?.columns).toEqual(['agentId']);
    });
});

describe('AgentMembership entity', () => {
    const storage = getMetadataArgsStorage();
    const table = storage.tables.find((t) => t.target === AgentMembership);
    const indices = storage.indices.filter((i) => i.target === AgentMembership);

    it('maps to `agent_memberships`', () => {
        expect(table?.name).toBe('agent_memberships');
    });

    it('UNIQUE on (agentId, targetType, targetId) + indexes by target', () => {
        const uq = indices.find((i) => i.name === 'uq_agent_membership');
        expect(uq?.unique).toBe(true);
        expect(uq?.columns).toEqual(['agentId', 'targetType', 'targetId']);
        expect(indices.some((i) => i.name === 'idx_agent_memberships_target')).toBe(true);
    });
});

describe('BudgetOwnerType enum', () => {
    it('includes AGENT value (Phase 1.5)', () => {
        expect(BudgetOwnerType.AGENT).toBe('agent');
    });
    it('still includes the prior values (no regression)', () => {
        expect(BudgetOwnerType.WORK).toBe('work');
        expect(BudgetOwnerType.MISSION).toBe('mission');
        expect(BudgetOwnerType.IDEA).toBe('idea');
    });
});
