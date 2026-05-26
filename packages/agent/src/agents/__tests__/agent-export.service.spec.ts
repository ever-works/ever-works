import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AgentExportService, type AgentExportEnvelope } from '../agent-export.service';
import {
    AgentAvatarMode,
    AgentIdleBehavior,
    AgentScope,
    AgentStatus,
} from '../../entities/agent.entity';
import type { Agent } from '../../entities/agent.entity';
import { ActivityActionType } from '../../entities/activity-log.types';

function makeAgent(over: Partial<Agent> = {}): Agent {
    return {
        id: 'src-a',
        userId: 'u1',
        scope: AgentScope.TENANT,
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'CEO',
        slug: 'ceo',
        title: 'Chief',
        capabilities: 'Sets direction',
        aiProviderId: 'openrouter',
        modelId: 'anthropic/claude-opus-4',
        maxSkillContextTokens: 4000,
        status: AgentStatus.ACTIVE,
        permissions: {
            canCreateAgents: true,
            canAssignTasks: true,
            canEditSkills: false,
            canEditAgentFiles: false,
            canSpend: false,
            canCommitToRepo: false,
            canOpenPullRequests: false,
            canCallExternalTools: false,
        },
        targets: null,
        heartbeatCadence: '*/15 * * * *',
        idleBehavior: AgentIdleBehavior.PROPOSE,
        nextHeartbeatAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: AgentAvatarMode.INITIALS,
        avatarIcon: null,
        avatarImageUploadId: null,
        soulMd: '# Who I am\nThe boss.',
        agentsMd: '# Roster\nAlone for now.',
        heartbeatMd: '# Each tick\nReview Missions.',
        toolsMd: '# Tools\nNone.',
        agentYml: 'version: 1\n',
        contentHash: 'abc123',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Agent;
}

describe('AgentExportService', () => {
    let agents: any;
    let memberships: any;
    let budgets: any;
    let activity: any;
    let svc: AgentExportService;

    beforeEach(() => {
        agents = {
            findById: jest.fn(),
            findByIdAndUser: jest.fn(),
            findByUserIdAndSlug: jest.fn(),
            create: jest.fn(),
            updateById: jest.fn(),
        };
        memberships = { replaceForAgent: jest.fn().mockResolvedValue(undefined) };
        budgets = { findByAgentId: jest.fn().mockResolvedValue(null) };
        activity = { log: jest.fn().mockResolvedValue(undefined) };
        svc = new AgentExportService(agents, memberships, budgets, activity);
    });

    describe('exportOne', () => {
        it('404s for cross-user', async () => {
            agents.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(svc.exportOne('u1', 'a1')).rejects.toThrow(NotFoundException);
        });

        it('returns an envelope shaped per spec §5.11', async () => {
            agents.findByIdAndUser.mockResolvedValueOnce(makeAgent());
            const env = await svc.exportOne('u1', 'src-a');
            expect(env.version).toBe(1);
            expect(env.identity.name).toBe('CEO');
            expect(env.identity.slug).toBe('ceo');
            expect(env.identity.scope).toBe(AgentScope.TENANT);
            expect(env.files.soulMd).toBe('# Who I am\nThe boss.');
            expect(env.runtime.heartbeatCadence).toBe('*/15 * * * *');
            expect(env.skillBindings).toEqual([]);
            expect(env.budget).toEqual([]);
        });

        it('emits AGENT_EXPORTED activity row', async () => {
            agents.findByIdAndUser.mockResolvedValueOnce(makeAgent());
            await svc.exportOne('u1', 'src-a');
            expect(activity.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: ActivityActionType.AGENT_EXPORTED }),
            );
        });
    });

    describe('importOne', () => {
        const baseEnvelope = (): AgentExportEnvelope => ({
            version: 1,
            meta: {
                exportedAt: '2026-05-26T00:00:00Z',
                sourceAgentId: 'src-a',
                sourceUserId: 'u1',
            },
            identity: {
                name: 'CEO',
                slug: 'ceo',
                title: 'Chief',
                capabilities: null,
                scope: AgentScope.TENANT,
            },
            model: { aiProviderId: null, modelId: null, maxSkillContextTokens: 4000 },
            runtime: {
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
                pauseAfterFailures: 3,
            },
            avatar: { mode: AgentAvatarMode.INITIALS, icon: null, imageUploadId: null },
            files: {
                soulMd: '# Hi',
                agentsMd: null,
                heartbeatMd: null,
                toolsMd: null,
                agentYml: null,
            },
            skillBindings: [],
            budget: [],
        });

        it('rejects an envelope with unsupported version', async () => {
            const env = { ...baseEnvelope(), version: 2 as any };
            await expect(svc.importOne('u1', env as any)).rejects.toThrow(
                /Unsupported envelope version/,
            );
        });

        it('rejects scope+ids mismatch (TENANT must not carry workId)', async () => {
            await expect(
                svc.importOne('u1', baseEnvelope(), {
                    workId: 'w1' as any,
                    overrideScope: AgentScope.TENANT,
                }),
            ).rejects.toThrow(BadRequestException);
        });

        it('happy path — creates a draft Agent with unique slug', async () => {
            agents.findByUserIdAndSlug.mockResolvedValue(null);
            agents.create.mockResolvedValueOnce(
                makeAgent({ id: 'new-a', status: AgentStatus.DRAFT }),
            );
            const res = await svc.importOne('u1', baseEnvelope());
            expect(res.conflictResolution).toBe('none');
            expect(res.originalSlug).toBe('ceo');
            expect(res.finalSlug).toBe('ceo');
            expect(agents.create).toHaveBeenCalledWith(
                expect.objectContaining({ status: AgentStatus.DRAFT, slug: 'ceo', userId: 'u1' }),
            );
            expect(activity.log).toHaveBeenCalledWith(
                expect.objectContaining({ actionType: ActivityActionType.AGENT_IMPORTED }),
            );
        });

        it('conflict skip — throws ConflictException', async () => {
            agents.findByUserIdAndSlug.mockResolvedValueOnce(makeAgent({ id: 'existing' }));
            await expect(
                svc.importOne('u1', baseEnvelope(), { onConflict: 'skip' }),
            ).rejects.toThrow(ConflictException);
        });

        it('conflict rename — appends -2 when "ceo" taken', async () => {
            agents.findByUserIdAndSlug
                .mockResolvedValueOnce(makeAgent({ id: 'existing-ceo' })) // first slug check
                .mockResolvedValueOnce(null); // ceo-2 is free
            agents.create.mockResolvedValueOnce(makeAgent({ id: 'new-a', slug: 'ceo-2' }));
            const res = await svc.importOne('u1', baseEnvelope(), { onConflict: 'rename' });
            expect(res.conflictResolution).toBe('renamed');
            expect(res.finalSlug).toBe('ceo-2');
        });

        it('conflict overwrite — patches existing row and returns conflictResolution=overwritten', async () => {
            const existing = makeAgent({ id: 'existing-ceo' });
            agents.findByUserIdAndSlug.mockResolvedValueOnce(existing);
            agents.findById.mockResolvedValueOnce({
                ...existing,
                name: baseEnvelope().identity.name,
                soulMd: '# Hi',
            });
            const res = await svc.importOne('u1', baseEnvelope(), { onConflict: 'overwrite' });
            expect(res.conflictResolution).toBe('overwritten');
            expect(agents.updateById).toHaveBeenCalledWith(
                'existing-ceo',
                expect.objectContaining({ soulMd: '# Hi' }),
            );
        });

        it('rejects secret in any file body', async () => {
            const env = baseEnvelope();
            env.files.toolsMd = 'GH=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
            await expect(svc.importOne('u1', env)).rejects.toThrow(/Secret-like/);
        });
    });
});
