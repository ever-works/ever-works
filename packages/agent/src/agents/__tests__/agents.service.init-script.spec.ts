import { BadRequestException } from '@nestjs/common';
import { AgentsService } from '../agents.service';
import {
    Agent,
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
} from '../../entities/agent.entity';

/**
 * Capabilities tab — `agents.initScript` write path.
 *
 * The init script rides `AgentsService.update` (PATCH). Pins the four
 * behaviours the Capabilities editor relies on:
 *
 *  - a real script persists verbatim;
 *  - null / blank clears back to NULL (an emptied editor never stores "");
 *  - > 16 KB is a 400 BEFORE any write;
 *  - a secret-like value is hard-rejected (same posture as agent files).
 */

function makeRepo(agent: Agent) {
    return {
        findById: jest.fn().mockResolvedValue(agent),
        findByIdAndUser: jest.fn().mockResolvedValue(agent),
        findByUserIdAndSlug: jest.fn().mockResolvedValue(null),
        updateById: jest.fn().mockResolvedValue(undefined),
    } as never;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
    return {
        id: 'a1',
        userId: 'u1',
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'CEO',
        slug: 'ceo',
        title: null,
        capabilities: null,
        aiProviderId: null,
        modelId: null,
        maxSkillContextTokens: 4000,
        status: AgentStatus.DRAFT,
        permissions: {
            canCreateAgents: false,
            canAssignTasks: false,
            canEditSkills: false,
            canEditAgentFiles: false,
            canSpend: false,
            canCommitToRepo: false,
            canOpenPullRequests: false,
            canCallExternalTools: false,
        },
        targets: null,
        heartbeatCadence: null,
        idleBehavior: AgentIdleBehavior.PROPOSE,
        nextHeartbeatAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: AgentAvatarMode.INITIALS,
        avatarIcon: null,
        avatarImageUploadId: null,
        initScript: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...overrides,
    } as Agent;
}

function makeService(agent: Agent): { service: AgentsService; repo: { updateById: jest.Mock } } {
    const repo = makeRepo(agent) as { updateById: jest.Mock };
    const memberships = { replaceForAgent: jest.fn() } as never;
    const budgets = {} as never;
    const service = new AgentsService(repo as never, memberships, budgets);
    return { service, repo };
}

describe('AgentsService.update — initScript', () => {
    it('persists a script verbatim', async () => {
        const { service, repo } = makeService(makeAgent());
        const script = '#!/bin/sh\npnpm install\npnpm build\n';
        await service.update('u1', 'a1', { initScript: script });
        expect(repo.updateById).toHaveBeenCalledWith('a1', { initScript: script });
    });

    it('clears to null on null AND on blank input (never stores "")', async () => {
        for (const cleared of [null, '', '   \n\t ']) {
            const { service, repo } = makeService(makeAgent({ initScript: 'old' }));
            await service.update('u1', 'a1', { initScript: cleared });
            expect(repo.updateById).toHaveBeenCalledWith('a1', { initScript: null });
        }
    });

    it('leaves the column untouched when the field is omitted', async () => {
        const { service, repo } = makeService(makeAgent({ initScript: 'keep me' }));
        await service.update('u1', 'a1', { title: 'New title' });
        const patch = repo.updateById.mock.calls[0][1];
        expect('initScript' in patch).toBe(false);
    });

    it('rejects a script over the 16 KB byte cap before writing', async () => {
        const { service, repo } = makeService(makeAgent());
        const tooBig = 'x'.repeat(16 * 1024 + 1);
        await expect(service.update('u1', 'a1', { initScript: tooBig })).rejects.toThrow(
            BadRequestException,
        );
        expect(repo.updateById).not.toHaveBeenCalled();
    });

    it('accepts a script exactly at the 16 KB cap', async () => {
        const { service, repo } = makeService(makeAgent());
        const atCap = 'x'.repeat(16 * 1024);
        await service.update('u1', 'a1', { initScript: atCap });
        expect(repo.updateById).toHaveBeenCalledWith('a1', { initScript: atCap });
    });

    it('hard-rejects a secret-like value (same posture as agent files)', async () => {
        const { service, repo } = makeService(makeAgent());
        const leaky = `export GITHUB_TOKEN=ghp_${'a'.repeat(36)}\npnpm install`;
        await expect(service.update('u1', 'a1', { initScript: leaky })).rejects.toThrow(
            /Secret-like value/,
        );
        expect(repo.updateById).not.toHaveBeenCalled();
    });
});
