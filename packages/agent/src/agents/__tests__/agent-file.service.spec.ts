import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AgentFileService } from '../agent-file.service';
import {
    AgentScope,
    AgentStatus,
    AgentAvatarMode,
    AgentIdleBehavior,
} from '../../entities/agent.entity';
import type { Agent } from '../../entities/agent.entity';
import { ActivityActionType } from '../../entities/activity-log.types';

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
        soulMd: null,
        agentsMd: null,
        heartbeatMd: null,
        toolsMd: null,
        agentYml: null,
        contentHash: null,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...overrides,
    } as Agent;
}

describe('AgentFileService', () => {
    let repo: any;
    let activity: any;
    let svc: AgentFileService;

    beforeEach(() => {
        repo = {
            findByIdAndUser: jest.fn(),
            updateById: jest.fn(),
        };
        activity = { log: jest.fn().mockResolvedValue(undefined) };
        svc = new AgentFileService(repo, activity);
    });

    describe('read', () => {
        it('404s for cross-user', async () => {
            repo.findByIdAndUser.mockResolvedValueOnce(null);
            await expect(svc.read('u1', 'a1', 'SOUL.md')).rejects.toThrow(NotFoundException);
        });

        it('reads inline body for tenant-scoped Agent', async () => {
            repo.findByIdAndUser.mockResolvedValueOnce(
                makeAgent({ soulMd: '# Hi', contentHash: 'h1' }),
            );
            const res = await svc.read('u1', 'a1', 'SOUL.md');
            expect(res).toEqual({ name: 'SOUL.md', body: '# Hi', hash: 'h1', storage: 'db' });
        });

        it('returns empty body when inline column is null', async () => {
            repo.findByIdAndUser.mockResolvedValueOnce(makeAgent());
            const res = await svc.read('u1', 'a1', 'AGENTS.md');
            expect(res.body).toBe('');
        });

        it('rejects invalid file names (path traversal mitigation)', async () => {
            await expect(svc.read('u1', 'a1', '../etc/passwd' as any)).rejects.toThrow(
                BadRequestException,
            );
        });

        it('returns DB-inline body for Mission-scoped Agent with no inline data (FU-14 fallback)', async () => {
            // FU-14 (post-PR-1019 follow-up) eliminated the
            // "Git-mode lands in Phase 6" throw — Mission/Idea/Work-
            // scoped Agents now fall back to DB-inline storage when
            // their scope repo isn't wired. Read returns the (empty)
            // inline body with storage='db'.
            repo.findByIdAndUser.mockResolvedValueOnce(
                makeAgent({ scope: AgentScope.MISSION, missionId: 'm1' }),
            );
            const res = await svc.read('u1', 'a1', 'SOUL.md');
            expect(res).toEqual({ name: 'SOUL.md', body: '', hash: '', storage: 'db' });
        });
    });

    describe('write', () => {
        it('rejects invalid file name', async () => {
            await expect(
                svc.write({ userId: 'u1', agentId: 'a1', name: 'WRONG.md' as any, body: 'x' }),
            ).rejects.toThrow(BadRequestException);
        });

        it('rejects body exceeding 64 KB cap', async () => {
            const huge = 'a'.repeat(64 * 1024 + 1);
            repo.findByIdAndUser.mockResolvedValueOnce(makeAgent());
            await expect(
                svc.write({ userId: 'u1', agentId: 'a1', name: 'SOUL.md', body: huge }),
            ).rejects.toThrow(/max 64 KB/);
        });

        it('rejects body containing a secret pattern', async () => {
            repo.findByIdAndUser.mockResolvedValueOnce(makeAgent());
            await expect(
                svc.write({
                    userId: 'u1',
                    agentId: 'a1',
                    name: 'TOOLS.md',
                    body: 'GH=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
                }),
            ).rejects.toThrow(/Secret-like value/);
        });

        it('happy path: persists, hashes, emits AGENT_FILE_EDITED activity row', async () => {
            repo.findByIdAndUser.mockResolvedValueOnce(makeAgent({ contentHash: null }));
            const out = await svc.write({
                userId: 'u1',
                agentId: 'a1',
                name: 'SOUL.md',
                body: '# Who I am\nNew identity.',
            });
            expect(out.newHash).toMatch(/^[a-f0-9]{64}$/);
            expect(repo.updateById).toHaveBeenCalledWith(
                'a1',
                expect.objectContaining({
                    soulMd: '# Who I am\nNew identity.',
                    contentHash: out.newHash,
                }),
            );
            expect(activity.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.AGENT_FILE_EDITED,
                    action: 'agent_file_edited',
                }),
            );
        });

        it('optimistic concurrency: rejects when expectedHash mismatches + emits AGENT_FILE_REVERTED', async () => {
            repo.findByIdAndUser.mockResolvedValueOnce(makeAgent({ contentHash: 'currenthash' }));
            await expect(
                svc.write({
                    userId: 'u1',
                    agentId: 'a1',
                    name: 'SOUL.md',
                    body: 'new',
                    expectedHash: 'stalehash',
                }),
            ).rejects.toThrow(/etag mismatch/);
            expect(activity.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: ActivityActionType.AGENT_FILE_REVERTED,
                }),
            );
            expect(repo.updateById).not.toHaveBeenCalled();
        });

        describe('activity actor', () => {
            const RUN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

            it('names the signed-in user as the actor of a save and of a refused save', async () => {
                repo.findByIdAndUser.mockResolvedValueOnce(makeAgent({ contentHash: null }));
                await svc.write({ userId: 'u1', agentId: 'a1', name: 'SOUL.md', body: 'A' });
                repo.findByIdAndUser.mockResolvedValueOnce(makeAgent({ contentHash: 'current' }));
                await expect(
                    svc.write({
                        userId: 'u1',
                        agentId: 'a1',
                        name: 'SOUL.md',
                        body: 'B',
                        expectedHash: 'stale',
                    }),
                ).rejects.toThrow(/etag mismatch/);

                expect(activity.log).toHaveBeenCalledTimes(2);
                const [edited, reverted] = activity.log.mock.calls.map(
                    ([payload]: [Record<string, any>]) => payload,
                );
                expect(edited.actionType).toBe(ActivityActionType.AGENT_FILE_EDITED);
                expect(reverted.actionType).toBe(ActivityActionType.AGENT_FILE_REVERTED);
                for (const payload of [edited, reverted]) {
                    expect(payload.actorKind).toBe('user');
                    expect(payload.actorAgentId).toBeUndefined();
                    // The agent whose file changed stays referenced as the subject.
                    expect(payload.details.agentId).toBe('a1');
                    expect(payload.details.runId).toBeUndefined();
                }
            });

            it('names the agent as the actor when it saves its own file from a run', async () => {
                repo.findByIdAndUser.mockResolvedValueOnce(makeAgent({ contentHash: null }));
                await svc.write({
                    userId: 'u1',
                    agentId: 'a1',
                    name: 'TOOLS.md',
                    body: 'A',
                    actor: 'agent',
                    runId: RUN,
                });
                repo.findByIdAndUser.mockResolvedValueOnce(makeAgent({ contentHash: 'current' }));
                await expect(
                    svc.write({
                        userId: 'u1',
                        agentId: 'a1',
                        name: 'TOOLS.md',
                        body: 'B',
                        expectedHash: 'stale',
                        actor: 'agent',
                        runId: RUN,
                    }),
                ).rejects.toThrow(/etag mismatch/);

                for (const [payload] of activity.log.mock.calls) {
                    expect(payload).toMatchObject({ actorKind: 'agent', actorAgentId: 'a1' });
                    expect(payload.details).toMatchObject({ agentId: 'a1', runId: RUN });
                }
            });

            it('does not record a run id that is not a uuid', async () => {
                repo.findByIdAndUser.mockResolvedValueOnce(makeAgent({ contentHash: null }));
                await svc.write({
                    userId: 'u1',
                    agentId: 'a1',
                    name: 'SOUL.md',
                    body: 'A',
                    actor: 'agent',
                    runId: 'no-run',
                });
                const [payload] = activity.log.mock.calls[0];
                expect(payload.actorKind).toBe('agent');
                expect(payload.details.runId).toBeUndefined();
            });
        });

        it('hash differs across distinct file edits (content addressing)', async () => {
            repo.findByIdAndUser.mockResolvedValueOnce(makeAgent({ contentHash: null }));
            const r1 = await svc.write({ userId: 'u1', agentId: 'a1', name: 'SOUL.md', body: 'A' });
            repo.findByIdAndUser.mockResolvedValueOnce(makeAgent({ contentHash: null }));
            const r2 = await svc.write({
                userId: 'u1',
                agentId: 'a1',
                name: 'AGENTS.md',
                body: 'A',
            });
            expect(r1.newHash).not.toBe(r2.newHash);
        });
    });
});
