import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AgentExportService, type AgentExportEnvelope } from '../agent-export.service';
import {
    AGENT_PERMISSIONS_DEFAULT,
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

        // Security (D9) — clamp imported permissions to least-privilege.
        // The envelope is attacker-editable, so an import must NEVER carry
        // its `runtime.permissions` into the created/overwritten Agent;
        // every imported Agent starts at the all-false frozen default and
        // the owner must explicitly re-grant.
        describe('permission clamp (D9)', () => {
            const elevatedEnvelope = (): AgentExportEnvelope => {
                const env = baseEnvelope();
                env.runtime.permissions = {
                    canCreateAgents: true,
                    canAssignTasks: true,
                    canEditSkills: true,
                    canEditAgentFiles: true,
                    canSpend: true,
                    canCommitToRepo: true,
                    canOpenPullRequests: true,
                    canCallExternalTools: true,
                };
                return env;
            };

            it('does NOT honour elevated envelope permissions on create — clamps to AGENT_PERMISSIONS_DEFAULT', async () => {
                agents.findByUserIdAndSlug.mockResolvedValue(null);
                agents.create.mockResolvedValueOnce(
                    makeAgent({ id: 'new-a', status: AgentStatus.DRAFT }),
                );
                await svc.importOne('u1', elevatedEnvelope());

                const createArg = agents.create.mock.calls[0][0];
                expect(createArg.permissions).toEqual(AGENT_PERMISSIONS_DEFAULT);
                // Every flag is false — no privilege escalation across import.
                expect(Object.values(createArg.permissions).every((v) => v === false)).toBe(true);
            });

            it('clamps permissions on the overwrite path too', async () => {
                const existing = makeAgent({ id: 'existing-ceo' });
                agents.findByUserIdAndSlug.mockResolvedValueOnce(existing);
                agents.findById.mockResolvedValueOnce(existing);
                await svc.importOne('u1', elevatedEnvelope(), { onConflict: 'overwrite' });

                expect(agents.updateById).toHaveBeenCalledWith(
                    'existing-ceo',
                    expect.objectContaining({ permissions: AGENT_PERMISSIONS_DEFAULT }),
                );
                const patch = agents.updateById.mock.calls[0][1];
                expect(Object.values(patch.permissions).every((v) => v === false)).toBe(true);
            });

            it('legit import (default permissions) still creates a draft Agent unchanged', async () => {
                // baseEnvelope already carries the all-false default set.
                agents.findByUserIdAndSlug.mockResolvedValue(null);
                agents.create.mockResolvedValueOnce(
                    makeAgent({ id: 'new-a', status: AgentStatus.DRAFT }),
                );
                const res = await svc.importOne('u1', baseEnvelope());
                expect(res.conflictResolution).toBe('none');
                const createArg = agents.create.mock.calls[0][0];
                expect(createArg.permissions).toEqual(AGENT_PERMISSIONS_DEFAULT);
                expect(createArg.status).toBe(AgentStatus.DRAFT);
            });
        });

        // Security (EW-711 #8) — scope-ownership IDOR. The scope columns are
        // NOT FK-constrained, so without this guard any authenticated user
        // could plant an imported Agent under another user's
        // Mission/Idea/Work id. These tests construct the service WITH the
        // raw Agent repository (5th ctor arg) so `assertScopeOwned` runs its
        // live `manager.getRepository(...).count(...)` ownership check.
        describe('scope-ownership (EW-711 #8)', () => {
            let scopeCount: jest.Mock;
            let svcWithRepo: AgentExportService;

            const missionEnvelope = (): AgentExportEnvelope => ({
                ...baseEnvelope(),
                identity: { ...baseEnvelope().identity, scope: AgentScope.MISSION },
            });

            beforeEach(() => {
                scopeCount = jest.fn();
                // Minimal `Repository<Agent>` stand-in: only `.manager.getRepository().count`
                // is exercised by the ownership check.
                const agentEntityRepo = {
                    manager: {
                        getRepository: jest.fn().mockReturnValue({ count: scopeCount }),
                    },
                } as any;
                svcWithRepo = new AgentExportService(
                    agents,
                    memberships,
                    budgets,
                    activity,
                    agentEntityRepo,
                );
            });

            it('404s when the target Mission is not owned by the caller', async () => {
                scopeCount.mockResolvedValueOnce(0); // mission m1 not owned by u1
                await expect(
                    svcWithRepo.importOne('u1', missionEnvelope(), {
                        overrideScope: AgentScope.MISSION,
                        missionId: 'm1',
                    }),
                ).rejects.toThrow(NotFoundException);
                // Rejected BEFORE any Agent row is created.
                expect(agents.create).not.toHaveBeenCalled();
                expect(scopeCount).toHaveBeenCalledWith({ where: { id: 'm1', userId: 'u1' } });
            });

            it('creates the Agent when the caller owns the target Mission', async () => {
                scopeCount.mockResolvedValueOnce(1); // mission m1 owned by u1
                agents.findByUserIdAndSlug.mockResolvedValue(null);
                agents.create.mockResolvedValueOnce(
                    makeAgent({
                        id: 'new-a',
                        scope: AgentScope.MISSION,
                        missionId: 'm1',
                        status: AgentStatus.DRAFT,
                    }),
                );
                const res = await svcWithRepo.importOne('u1', missionEnvelope(), {
                    overrideScope: AgentScope.MISSION,
                    missionId: 'm1',
                });
                expect(res.conflictResolution).toBe('none');
                expect(agents.create).toHaveBeenCalledWith(
                    expect.objectContaining({ scope: AgentScope.MISSION, missionId: 'm1' }),
                );
            });

            it('does not own-check TENANT-scoped imports (no target id)', async () => {
                agents.findByUserIdAndSlug.mockResolvedValue(null);
                agents.create.mockResolvedValueOnce(
                    makeAgent({ id: 'new-a', status: AgentStatus.DRAFT }),
                );
                await svcWithRepo.importOne('u1', baseEnvelope());
                expect(scopeCount).not.toHaveBeenCalled();
                expect(agents.create).toHaveBeenCalled();
            });
        });
    });
});
