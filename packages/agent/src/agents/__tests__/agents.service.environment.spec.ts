import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AgentsService } from '../agents.service';
import { AgentScope, AgentStatus, AGENT_PERMISSIONS_DEFAULT } from '../../entities/agent.entity';
import type { AgentRepository } from '../../database/repositories/agent.repository';
import type { AgentMembershipRepository } from '../../database/repositories/agent-membership.repository';
import type { AgentBudgetRepository } from '../../database/repositories/agent-budget.repository';

/**
 * Environments — the per-Agent assignment rule, server-side:
 * `agents.environmentId` may only point at the caller's own PUBLISHED
 * Environment (draft → 422, cross-user/unknown → 404), and `null`
 * clears back to the platform default.
 */

const USER = 'user-1';

function makeAgentRow() {
    return {
        id: 'agent-1',
        userId: USER,
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'Analyst',
        slug: 'analyst',
        status: AgentStatus.DRAFT,
        permissions: { ...AGENT_PERMISSIONS_DEFAULT },
        maxSkillContextTokens: 4000,
        idleBehavior: 'propose',
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: 'initials',
        environmentId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
}

function makeService(environmentRow: { id: string; userId: string; status: string } | null) {
    const row = makeAgentRow();
    const agents = {
        findByIdAndUser: jest.fn().mockResolvedValue(row),
        findById: jest.fn().mockResolvedValue(row),
        findByUserIdAndSlug: jest.fn().mockResolvedValue(null),
        updateById: jest.fn().mockResolvedValue(undefined),
    };
    const memberships = { replaceForAgent: jest.fn() };
    const budgets = {};
    const environmentRepo = {
        findOne: jest.fn().mockImplementation(async ({ where }: any) => {
            if (!environmentRow) return null;
            return environmentRow.id === where.id && environmentRow.userId === where.userId
                ? environmentRow
                : null;
        }),
    };

    const service = new AgentsService(
        agents as unknown as AgentRepository,
        memberships as unknown as AgentMembershipRepository,
        budgets as unknown as AgentBudgetRepository,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        environmentRepo as never,
    );
    return { service, agents, environmentRepo };
}

describe('AgentsService — environment assignment (update)', () => {
    it('persists a published, same-user environment id', async () => {
        const { service, agents } = makeService({
            id: 'env-1',
            userId: USER,
            status: 'published',
        });

        await service.update(USER, 'agent-1', { environmentId: 'env-1' });

        expect(agents.updateById).toHaveBeenCalledWith(
            'agent-1',
            expect.objectContaining({ environmentId: 'env-1' }),
        );
    });

    it('refuses a draft environment with a 422 and a clear message', async () => {
        const { service, agents } = makeService({ id: 'env-1', userId: USER, status: 'draft' });

        await expect(
            service.update(USER, 'agent-1', { environmentId: 'env-1' }),
        ).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(agents.updateById).not.toHaveBeenCalled();
    });

    it('404s on a cross-user or unknown environment (no existence leak)', async () => {
        const { service } = makeService({ id: 'env-1', userId: 'someone-else', status: 'published' });

        await expect(
            service.update(USER, 'agent-1', { environmentId: 'env-1' }),
        ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('null clears the assignment without touching the environment repo', async () => {
        const { service, agents, environmentRepo } = makeService(null);

        await service.update(USER, 'agent-1', { environmentId: null });

        expect(environmentRepo.findOne).not.toHaveBeenCalled();
        expect(agents.updateById).toHaveBeenCalledWith(
            'agent-1',
            expect.objectContaining({ environmentId: null }),
        );
    });

    it('an undefined environmentId leaves the column out of the patch entirely', async () => {
        const { service, agents } = makeService(null);

        await service.update(USER, 'agent-1', { title: 'Senior Analyst' });

        const patch = agents.updateById.mock.calls[0][1];
        expect('environmentId' in patch).toBe(false);
    });
});
