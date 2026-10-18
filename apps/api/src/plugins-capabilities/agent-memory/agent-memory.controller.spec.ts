jest.mock('@ever-works/agent/facades', () => ({
    AgentMemoryFacadeService: class {},
    NoProviderError: class NoProviderError extends Error {
        constructor(capability?: string) {
            super(`No provider for ${capability ?? 'unknown'}`);
            this.name = 'NoProviderError';
        }
    },
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class {},
}));
jest.mock('../../auth', () => ({
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AgentMemoryController } from './agent-memory.controller';
import { NoProviderError } from '@ever-works/agent/facades';
import type { AgentMemoryFacadeService } from '@ever-works/agent/facades';
import type { WorkOwnershipService } from '@ever-works/agent/services';
import type { AuthenticatedUser } from '../../auth/types/auth.types';

describe('AgentMemoryController', () => {
    let agentMemory: {
        isConfigured: jest.Mock;
        getDefaultProvider: jest.Mock;
        openSession: jest.Mock;
        closeSession: jest.Mock;
        listSessions: jest.Mock;
        saveMemory: jest.Mock;
        searchMemory: jest.Mock;
        buildContext: jest.Mock;
        deleteEntry: jest.Mock;
    };
    let ownership: { ensureCanView: jest.Mock; ensureCanEdit: jest.Mock };
    let controller: AgentMemoryController;
    const auth: AuthenticatedUser = { userId: 'user-1' } as any;

    beforeEach(() => {
        agentMemory = {
            isConfigured: jest.fn().mockReturnValue(true),
            getDefaultProvider: jest
                .fn()
                .mockResolvedValue({ id: 'agentmemory', name: 'Agent Memory' }),
            openSession: jest.fn().mockResolvedValue({ id: 's1', startedAt: 'now' }),
            closeSession: jest.fn().mockResolvedValue(undefined),
            listSessions: jest.fn().mockResolvedValue([]),
            saveMemory: jest.fn().mockResolvedValue({ id: 'm1', content: 'x', createdAt: 'now' }),
            searchMemory: jest.fn().mockResolvedValue({ results: [] }),
            buildContext: jest.fn().mockResolvedValue({ content: 'ctx' }),
            deleteEntry: jest.fn().mockResolvedValue(undefined),
        };
        ownership = {
            ensureCanView: jest.fn().mockImplementation(async (workId: string) => ({
                work: { id: workId, slug: `slug-of-${workId}` },
            })),
            ensureCanEdit: jest.fn().mockImplementation(async (workId: string) => ({
                work: { id: workId, slug: `slug-of-${workId}` },
            })),
        };
        controller = new AgentMemoryController(
            agentMemory as unknown as AgentMemoryFacadeService,
            ownership as unknown as WorkOwnershipService,
        );
    });

    describe('check-availability', () => {
        it('returns available=false with a hint when no provider is loaded', async () => {
            agentMemory.isConfigured.mockReturnValueOnce(false);
            const result = await controller.checkAvailability(auth);
            expect(result.available).toBe(false);
            expect(result.message).toMatch(/Install \+ enable an agent-memory plugin/);
        });

        it('returns available=true + the active provider when configured', async () => {
            const result = await controller.checkAvailability(auth);
            expect(result.available).toBe(true);
            expect(result.activeProvider).toEqual({ id: 'agentmemory', name: 'Agent Memory' });
        });
    });

    describe('ownership enforcement', () => {
        it('requires EDIT access (not view) when a workId is supplied on save', async () => {
            await controller.save(auth, {
                content: 'x',
                workId: 'work-1' as any,
            });
            expect(ownership.ensureCanEdit).toHaveBeenCalledWith('work-1', 'user-1');
            expect(ownership.ensureCanView).not.toHaveBeenCalled();
        });

        it('a save without a workId needs no Work access and keeps the configured/default project', async () => {
            await controller.save(auth, { content: 'x' });
            expect(ownership.ensureCanEdit).not.toHaveBeenCalled();
            // No projectId ⇒ the plugin resolves `settings.project` (else its
            // default), exactly as an install without a workId did before.
            expect(agentMemory.saveMemory.mock.calls[0][0].projectId).toBeUndefined();
        });

        it('lets ownership errors bubble (e.g. a viewer is refused with 403)', async () => {
            ownership.ensureCanEdit.mockRejectedValueOnce(new Error('not your work'));
            await expect(
                controller.save(auth, { content: 'x', workId: 'work-1' as any }),
            ).rejects.toThrow('not your work');
            expect(agentMemory.saveMemory).not.toHaveBeenCalled();
        });
    });

    describe('save', () => {
        it('forwards content + tags + metadata + sessionId to the facade, in the Work’s project', async () => {
            await controller.save(auth, {
                content: 'remember this',
                tags: ['bug'],
                metadata: { file: 'a.ts' },
                sessionId: 'sess-9',
                workId: 'work-1' as any,
                projectId: 'proj-A',
            });
            expect(agentMemory.saveMemory).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: 'remember this',
                    tags: ['bug'],
                    // Security (EW-711 #29): owner stamp folded into record metadata.
                    metadata: { file: 'a.ts', ownerUserId: 'user-1' },
                    sessionId: 'sess-9',
                    // Server-derived: the Work's id, never the caller's projectId.
                    projectId: 'work-1',
                }),
                expect.objectContaining({ userId: 'user-1', workId: 'work-1' }),
            );
        });

        it('never lets the caller name the project (a name falls back to the configured project)', async () => {
            await controller.save(auth, { content: 'x', projectId: 'someone-elses-project' });
            expect(agentMemory.saveMemory.mock.calls[0][0].projectId).toBeUndefined();
        });

        it('honours a caller projectId only when it is the id of a Work the caller may edit', async () => {
            const workId = '0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
            await controller.save(auth, { content: 'x', projectId: workId });
            expect(ownership.ensureCanEdit).toHaveBeenCalledWith(workId, 'user-1');
            expect(agentMemory.saveMemory).toHaveBeenLastCalledWith(
                expect.objectContaining({ projectId: workId }),
                expect.anything(),
            );

            ownership.ensureCanEdit.mockRejectedValueOnce(new ForbiddenException('viewer only'));
            await controller.save(auth, { content: 'y', projectId: workId });
            expect(agentMemory.saveMemory.mock.calls.at(-1)![0].projectId).toBeUndefined();

            ownership.ensureCanEdit.mockRejectedValueOnce(new NotFoundException('no such Work'));
            await controller.save(auth, { content: 'z', projectId: workId });
            expect(agentMemory.saveMemory.mock.calls.at(-1)![0].projectId).toBeUndefined();
        });

        // CodeRabbit on #2769: a Work named only by `projectId` also picks
        // that Work's provider and settings (the facade options carry it).
        it('carries a Work resolved from projectId into the facade options', async () => {
            const workId = '0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
            await controller.save(auth, { content: 'x', projectId: workId });
            expect(agentMemory.saveMemory).toHaveBeenLastCalledWith(
                expect.objectContaining({ projectId: workId }),
                { userId: 'user-1', workId },
            );
            await controller.search(auth, { query: 'q', projectId: workId } as any);
            expect(agentMemory.searchMemory.mock.calls.at(-1)![1]).toEqual({
                userId: 'user-1',
                workId,
            });
            // A refused or non-Work project carries no Work into the options.
            await controller.save(auth, { content: 'y', projectId: 'not-a-work' });
            expect(agentMemory.saveMemory.mock.calls.at(-1)![1]).toEqual({ userId: 'user-1' });
        });

        // CodeRabbit on #2769: an ownership-service FAILURE is not "no such
        // Work" — it propagates instead of saving into the default project.
        it('propagates an unexpected ownership failure instead of falling back', async () => {
            const workId = '0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
            ownership.ensureCanEdit.mockRejectedValueOnce(new Error('connection refused'));
            await expect(
                controller.save(auth, { content: 'x', projectId: workId }),
            ).rejects.toThrow('connection refused');
            expect(agentMemory.saveMemory).not.toHaveBeenCalled();
        });
    });

    describe('reads resolve the project exactly like writes (round trip)', () => {
        it('a memory saved for a Work is searched, listed and given as context in the SAME project', async () => {
            await controller.save(auth, { content: 'remember', workId: 'work-1' as any });
            await controller.search(auth, { query: 'remember', workId: 'work-1' as any });
            await controller.context(auth, { query: 'remember', workId: 'work-1' as any });
            await controller.listSessions(auth, { workId: 'work-1' as any });

            const saved = agentMemory.saveMemory.mock.calls[0][0].projectId;
            expect(saved).toBe('work-1');
            expect(agentMemory.searchMemory.mock.calls[0][0].projectId).toBe(saved);
            expect(agentMemory.buildContext.mock.calls[0][0].projectId).toBe(saved);
            expect(agentMemory.listSessions.mock.calls[0][0].projectId).toBe(saved);
        });

        it('reads need VIEW access with a workId; a caller projectId never redirects them', async () => {
            await controller.search(auth, {
                query: 'q',
                workId: 'work-1' as any,
                projectId: 'other',
            } as any);
            expect(ownership.ensureCanView).toHaveBeenCalledWith('work-1', 'user-1');
            expect(ownership.ensureCanEdit).not.toHaveBeenCalled();
            expect(agentMemory.searchMemory.mock.calls[0][0].projectId).toBe('work-1');
        });

        it('without a workId, reads and writes both use the configured/default project', async () => {
            await controller.save(auth, { content: 'x' });
            await controller.search(auth, { query: 'x' });
            expect(agentMemory.saveMemory.mock.calls[0][0].projectId).toBeUndefined();
            expect(agentMemory.searchMemory.mock.calls[0][0].projectId).toBeUndefined();
        });

        it('a read refused for a Work surfaces the ownership error and reads nothing', async () => {
            ownership.ensureCanView.mockRejectedValueOnce(new Error('not your work'));
            await expect(
                controller.search(auth, { query: 'q', workId: 'foreign' as any }),
            ).rejects.toThrow('not your work');
            expect(agentMemory.searchMemory).not.toHaveBeenCalled();
        });
    });

    describe('search', () => {
        it('returns the facade response unchanged + status:success', async () => {
            agentMemory.searchMemory.mockResolvedValueOnce({
                results: [{ id: '1', content: 'a', createdAt: 'now' }],
                summary: 's',
            });
            const result = await controller.search(auth, { query: 'q' });
            expect(result.status).toBe('success');
            expect(result.results).toHaveLength(1);
            expect(result.summary).toBe('s');
        });
    });

    describe('context', () => {
        it('maps maxTokens to the facade buildContext call', async () => {
            await controller.context(auth, { query: 'q', maxTokens: 1500 });
            expect(agentMemory.buildContext).toHaveBeenCalledWith(
                expect.objectContaining({ maxTokens: 1500 }),
                expect.any(Object),
            );
        });
    });

    describe('sessions', () => {
        it('openSession returns the facade session payload + stamps the owner', async () => {
            const result = await controller.openSession(auth, { metadata: { from: 'web' } });
            expect(result.session).toEqual({ id: 's1', startedAt: 'now' });
            // Security (EW-711 #29): owner stamp is folded into session metadata.
            expect(agentMemory.openSession).toHaveBeenCalledWith(
                { from: 'web', ownerUserId: 'user-1' },
                expect.objectContaining({ userId: 'user-1' }),
            );
        });

        it('openSession requires EDIT access and scopes to the Work’s project, ignoring a caller projectId', async () => {
            await controller.openSession(auth, {
                workId: 'work-1' as any,
                projectId: 'someone-elses-project',
                metadata: { projectId: 'forged' },
            } as any);
            expect(ownership.ensureCanEdit).toHaveBeenCalledWith('work-1', 'user-1');
            expect(agentMemory.openSession).toHaveBeenCalledWith(
                { projectId: 'work-1', ownerUserId: 'user-1' },
                expect.objectContaining({ userId: 'user-1', workId: 'work-1' }),
            );
        });

        it('openSession owner stamp cannot be spoofed from the request body', async () => {
            await controller.openSession(auth, { metadata: { ownerUserId: 'user-2' } as any });
            expect(agentMemory.openSession).toHaveBeenCalledWith(
                { ownerUserId: 'user-1' },
                expect.objectContaining({ userId: 'user-1' }),
            );
        });

        it('closeSession rejects an empty sessionId', async () => {
            await expect(controller.closeSession(auth, '', {})).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('closeSession enforces EDIT ownership + scopes by workId when one is supplied', async () => {
            // Security (EW-711 #29): mutating handler requires edit access, not view.
            await controller.closeSession(auth, 'sess-1', { workId: 'work-1' });
            expect(ownership.ensureCanEdit).toHaveBeenCalledWith('work-1', 'user-1');
            expect(ownership.ensureCanView).not.toHaveBeenCalled();
            expect(agentMemory.closeSession).toHaveBeenCalledWith(
                'sess-1',
                expect.objectContaining({ userId: 'user-1', workId: 'work-1' }),
            );
        });

        it('closeSession propagates an ownership rejection (cannot close another user Work session)', async () => {
            ownership.ensureCanEdit.mockRejectedValueOnce(new Error('not your work'));
            await expect(
                controller.closeSession(auth, 'sess-1', { workId: 'work-x' }),
            ).rejects.toThrow('not your work');
            expect(agentMemory.closeSession).not.toHaveBeenCalled();
        });

        it('closeSession rejects a foreign session even when workId is omitted (EW-711 #29 IDOR)', async () => {
            // The session surfaces in the caller's (shared-project) scope but
            // was opened by another user — the owner stamp must block the close.
            agentMemory.listSessions.mockResolvedValueOnce([
                { id: 'sess-foreign', metadata: { ownerUserId: 'user-2' } },
            ]);
            await expect(controller.closeSession(auth, 'sess-foreign', {})).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            expect(ownership.ensureCanEdit).not.toHaveBeenCalled();
            expect(agentMemory.closeSession).not.toHaveBeenCalled();
        });

        it('closeSession allows the caller to close their own session (workId omitted)', async () => {
            agentMemory.listSessions.mockResolvedValueOnce([
                { id: 'sess-mine', metadata: { ownerUserId: 'user-1' } },
            ]);
            await controller.closeSession(auth, 'sess-mine', {});
            expect(agentMemory.closeSession).toHaveBeenCalledWith(
                'sess-mine',
                expect.objectContaining({ userId: 'user-1' }),
            );
        });

        it('closeSession fails open when the provider does not support listSessions', async () => {
            // A backend without the optional governance surface can't be
            // enumerated — don't break the legit flow on a missing method.
            agentMemory.listSessions.mockRejectedValueOnce(
                new Error('Agent-memory provider "x" does not support listSessions'),
            );
            await controller.closeSession(auth, 'sess-1', {});
            expect(agentMemory.closeSession).toHaveBeenCalledWith('sess-1', expect.any(Object));
        });

        it('listSessions forwards limit, and a project only when it is a reachable Work', async () => {
            await controller.listSessions(auth, { limit: 5, projectId: 'p' });
            expect(agentMemory.listSessions).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 5, projectId: undefined }),
                expect.any(Object),
            );
        });
    });

    describe('deleteEntry', () => {
        it('rejects an empty entryId', async () => {
            await expect(controller.deleteEntry(auth, '', {})).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('passes the id to the facade', async () => {
            await controller.deleteEntry(auth, 'mem-42', {});
            expect(agentMemory.deleteEntry).toHaveBeenCalledWith(
                'mem-42',
                expect.objectContaining({ userId: 'user-1' }),
            );
        });

        it('enforces EDIT ownership + scopes by workId when one is supplied', async () => {
            // Security (EW-711 #29): forget is a mutation → requires edit access.
            await controller.deleteEntry(auth, 'mem-42', { workId: 'work-1' });
            expect(ownership.ensureCanEdit).toHaveBeenCalledWith('work-1', 'user-1');
            expect(ownership.ensureCanView).not.toHaveBeenCalled();
            expect(agentMemory.deleteEntry).toHaveBeenCalledWith(
                'mem-42',
                expect.objectContaining({ userId: 'user-1', workId: 'work-1' }),
            );
        });

        it('propagates an ownership rejection (cannot forget another user Work entry)', async () => {
            ownership.ensureCanEdit.mockRejectedValueOnce(new Error('not your work'));
            await expect(
                controller.deleteEntry(auth, 'mem-42', { workId: 'work-x' }),
            ).rejects.toThrow('not your work');
            expect(agentMemory.deleteEntry).not.toHaveBeenCalled();
        });

        it('rejects a foreign entry even when workId is omitted (EW-711 #29 IDOR)', async () => {
            // The record surfaces in the caller's shared-project search scope
            // but was saved by another user — the owner stamp must block it.
            agentMemory.searchMemory.mockResolvedValueOnce({
                results: [
                    {
                        id: 'mem-foreign',
                        content: 'x',
                        createdAt: 'now',
                        metadata: { ownerUserId: 'user-2' },
                    },
                ],
            });
            await expect(controller.deleteEntry(auth, 'mem-foreign', {})).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            expect(agentMemory.deleteEntry).not.toHaveBeenCalled();
        });

        it('allows the caller to forget their own entry (workId omitted)', async () => {
            agentMemory.searchMemory.mockResolvedValueOnce({
                results: [
                    {
                        id: 'mem-mine',
                        content: 'x',
                        createdAt: 'now',
                        metadata: { ownerUserId: 'user-1' },
                    },
                ],
            });
            await controller.deleteEntry(auth, 'mem-mine', {});
            expect(agentMemory.deleteEntry).toHaveBeenCalledWith(
                'mem-mine',
                expect.objectContaining({ userId: 'user-1' }),
            );
        });

        it('fails open when the provider does not support searchMemory enumeration', async () => {
            agentMemory.searchMemory.mockRejectedValueOnce(
                new Error('Agent-memory provider "x" does not support searchMemory'),
            );
            await controller.deleteEntry(auth, 'mem-1', {});
            expect(agentMemory.deleteEntry).toHaveBeenCalledWith('mem-1', expect.any(Object));
        });
    });

    describe('error mapping', () => {
        it('translates NoProviderError to 400 with a remediation hint', async () => {
            agentMemory.saveMemory.mockRejectedValueOnce(new NoProviderError('agent-memory'));
            try {
                await controller.save(auth, { content: 'x' });
                fail('expected throw');
            } catch (err) {
                expect(err).toBeInstanceOf(BadRequestException);
                const response = (err as BadRequestException).getResponse() as Record<
                    string,
                    unknown
                >;
                expect(response.message).toMatch(/Install \+ enable an agent-memory plugin/);
                expect(response.operation).toBe('saveMemory');
            }
        });

        it('translates "does not support" errors to 404 (optional method missing)', async () => {
            agentMemory.deleteEntry.mockRejectedValueOnce(
                new Error('Agent-memory provider "x" does not support deleteEntry'),
            );
            await expect(controller.deleteEntry(auth, 'mem-1', {})).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('translates anything else to 400 with the original message + operation tag', async () => {
            agentMemory.searchMemory.mockRejectedValueOnce(new Error('agentmemory unreachable'));
            try {
                await controller.search(auth, { query: 'q' });
                fail('expected throw');
            } catch (err) {
                expect(err).toBeInstanceOf(BadRequestException);
                const response = (err as BadRequestException).getResponse() as Record<
                    string,
                    unknown
                >;
                expect(response.message).toBe('agentmemory unreachable');
                expect(response.operation).toBe('searchMemory');
            }
        });
    });
});
