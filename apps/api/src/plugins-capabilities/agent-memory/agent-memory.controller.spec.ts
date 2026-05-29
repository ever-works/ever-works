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

import { BadRequestException, NotFoundException } from '@nestjs/common';
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
    let ownership: { ensureCanView: jest.Mock };
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
        ownership = { ensureCanView: jest.fn().mockResolvedValue(undefined) };
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
        it('calls WorkOwnershipService.ensureCanView when a workId is supplied on save', async () => {
            await controller.save(auth, {
                content: 'x',
                workId: 'work-1' as any,
            });
            expect(ownership.ensureCanView).toHaveBeenCalledWith('work-1', 'user-1');
        });

        it('skips ownership when workId is not supplied (platform-wide reads)', async () => {
            await controller.save(auth, { content: 'x' });
            expect(ownership.ensureCanView).not.toHaveBeenCalled();
        });

        it('lets ownership errors bubble (e.g. 403 from the underlying guard)', async () => {
            ownership.ensureCanView.mockRejectedValueOnce(new Error('not your work'));
            await expect(
                controller.save(auth, { content: 'x', workId: 'work-1' as any }),
            ).rejects.toThrow('not your work');
        });
    });

    describe('save', () => {
        it('forwards content + tags + metadata + sessionId + projectId to the facade', async () => {
            await controller.save(auth, {
                content: 'remember this',
                tags: ['bug'],
                metadata: { file: 'a.ts' },
                sessionId: 'sess-9',
                projectId: 'proj-A',
            });
            expect(agentMemory.saveMemory).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: 'remember this',
                    tags: ['bug'],
                    metadata: { file: 'a.ts' },
                    sessionId: 'sess-9',
                    projectId: 'proj-A',
                }),
                expect.objectContaining({ userId: 'user-1' }),
            );
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
        it('openSession returns the facade session payload', async () => {
            const result = await controller.openSession(auth, { metadata: { from: 'web' } });
            expect(result.session).toEqual({ id: 's1', startedAt: 'now' });
            expect(agentMemory.openSession).toHaveBeenCalledWith(
                { from: 'web' },
                expect.objectContaining({ userId: 'user-1' }),
            );
        });

        it('closeSession rejects an empty sessionId', async () => {
            await expect(controller.closeSession(auth, '', {})).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('closeSession enforces ownership + scopes by workId when one is supplied', async () => {
            await controller.closeSession(auth, 'sess-1', { workId: 'work-1' });
            expect(ownership.ensureCanView).toHaveBeenCalledWith('work-1', 'user-1');
            expect(agentMemory.closeSession).toHaveBeenCalledWith(
                'sess-1',
                expect.objectContaining({ userId: 'user-1', workId: 'work-1' }),
            );
        });

        it('closeSession propagates an ownership rejection (cannot close another user Work session)', async () => {
            ownership.ensureCanView.mockRejectedValueOnce(new Error('not your work'));
            await expect(
                controller.closeSession(auth, 'sess-1', { workId: 'work-x' }),
            ).rejects.toThrow('not your work');
            expect(agentMemory.closeSession).not.toHaveBeenCalled();
        });

        it('listSessions forwards limit + projectId', async () => {
            await controller.listSessions(auth, { limit: 5, projectId: 'p' });
            expect(agentMemory.listSessions).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 5, projectId: 'p' }),
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

        it('enforces ownership + scopes by workId when one is supplied', async () => {
            await controller.deleteEntry(auth, 'mem-42', { workId: 'work-1' });
            expect(ownership.ensureCanView).toHaveBeenCalledWith('work-1', 'user-1');
            expect(agentMemory.deleteEntry).toHaveBeenCalledWith(
                'mem-42',
                expect.objectContaining({ userId: 'user-1', workId: 'work-1' }),
            );
        });

        it('propagates an ownership rejection (cannot forget another user Work entry)', async () => {
            ownership.ensureCanView.mockRejectedValueOnce(new Error('not your work'));
            await expect(
                controller.deleteEntry(auth, 'mem-42', { workId: 'work-x' }),
            ).rejects.toThrow('not your work');
            expect(agentMemory.deleteEntry).not.toHaveBeenCalled();
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
