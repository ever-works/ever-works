import { WorkMemoryService } from '../work-memory.service';

/**
 * `WorkMemoryService` runs at the tail of a scheduled generation, AFTER the
 * run's output is already committed to git and its status written. So the
 * governing property is that it can never turn a succeeded run into a
 * failed one — every test here exists to pin some version of "does not
 * throw".
 */
function makeFacade(overrides: Partial<Record<string, jest.Mock>> = {}) {
    return {
        openSession: overrides.openSession ?? jest.fn().mockResolvedValue({ id: 'sess-1' }),
        saveMemory: overrides.saveMemory ?? jest.fn().mockResolvedValue({ id: 'mem-1' }),
        closeSession: overrides.closeSession ?? jest.fn().mockResolvedValue(undefined),
        searchMemory:
            overrides.searchMemory ??
            jest.fn().mockResolvedValue({ results: [{ content: 'prior finding', score: 0.9 }] }),
    };
}

const WORK = {
    id: 'work-1',
    name: 'Awesome Chairs',
    slug: 'awesome-chairs',
    kind: 'directory',
    userId: 'user-1',
} as never;

function noProviderError(): Error {
    const error = new Error('no agent-memory provider enabled');
    error.name = 'NoProviderError';
    return error;
}

describe('WorkMemoryService.recordRun', () => {
    it('opens a session, saves the finding, then closes the session', async () => {
        const facade = makeFacade();
        const service = new WorkMemoryService(facade as never);

        const sessionId = await service.recordRun({
            work: WORK,
            userId: 'user-1',
            summary: 'Scheduled run completed. 3 new items.',
            historyId: 'hist-1',
            scheduleId: 'sched-1',
            stats: { newItems: 3, updatedItems: 1, totalItems: 42 },
        });

        expect(sessionId).toBe('sess-1');
        expect(facade.openSession).toHaveBeenCalledTimes(1);
        expect(facade.saveMemory).toHaveBeenCalledTimes(1);
        expect(facade.closeSession).toHaveBeenCalledWith('sess-1', {
            userId: 'user-1',
            workId: 'work-1',
        });
    });

    /**
     * `workId` scopes provider resolution to the Work's own configured
     * memory provider. Without it a Work would write into a different store
     * from the one its own agents read.
     */
    it('scopes every call to the Work so it shares its agents store', async () => {
        const facade = makeFacade();
        const service = new WorkMemoryService(facade as never);

        await service.recordRun({ work: WORK, userId: 'user-1', summary: 'x' });

        for (const call of [facade.openSession, facade.saveMemory]) {
            expect(call.mock.calls[0][1]).toEqual({ userId: 'user-1', workId: 'work-1' });
        }
    });

    it('tags the memory so the Work can retrieve its own history later', async () => {
        const facade = makeFacade();
        const service = new WorkMemoryService(facade as never);

        await service.recordRun({ work: WORK, userId: 'user-1', summary: 'x' });

        const [saved] = facade.saveMemory.mock.calls[0];
        expect(saved.tags).toEqual(['work-run', 'work:work-1', 'kind:directory']);
        expect(saved.sessionId).toBe('sess-1');
        expect(saved.metadata).toMatchObject({ workId: 'work-1', workSlug: 'awesome-chairs' });
    });

    it('falls back to the default kind tag when the Work has none', async () => {
        const facade = makeFacade();
        const service = new WorkMemoryService(facade as never);

        await service.recordRun({
            work: { ...(WORK as object), kind: undefined } as never,
            userId: 'user-1',
            summary: 'x',
        });

        expect(facade.saveMemory.mock.calls[0][0].tags).toContain('kind:default');
    });

    it('is a no-op when no memory facade is wired at all', async () => {
        const service = new WorkMemoryService(undefined);
        await expect(
            service.recordRun({ work: WORK, userId: 'user-1', summary: 'x' }),
        ).resolves.toBeNull();
    });

    it('stays quiet when the user has no memory provider enabled', async () => {
        const facade = makeFacade({
            openSession: jest.fn().mockRejectedValue(noProviderError()),
        });
        const service = new WorkMemoryService(facade as never);

        await expect(
            service.recordRun({ work: WORK, userId: 'user-1', summary: 'x' }),
        ).resolves.toBeNull();
        expect(facade.saveMemory).not.toHaveBeenCalled();
        expect(facade.closeSession).not.toHaveBeenCalled();
    });

    it('does not throw when saving fails, and still closes the session', async () => {
        const facade = makeFacade({
            saveMemory: jest.fn().mockRejectedValue(new Error('provider exploded')),
        });
        const service = new WorkMemoryService(facade as never);

        await expect(
            service.recordRun({ work: WORK, userId: 'user-1', summary: 'x' }),
        ).resolves.toBeNull();
        // The session was opened, so it must be released even though the
        // save failed — otherwise a provider leaks an open session per run.
        expect(facade.closeSession).toHaveBeenCalledWith('sess-1', expect.anything());
    });

    /**
     * A save that succeeded must not be reported as a failure because the
     * close afterwards did not land.
     */
    it('still reports success when only the close fails', async () => {
        const facade = makeFacade({
            closeSession: jest.fn().mockRejectedValue(new Error('close failed')),
        });
        const service = new WorkMemoryService(facade as never);

        await expect(
            service.recordRun({ work: WORK, userId: 'user-1', summary: 'x' }),
        ).resolves.toBe('sess-1');
    });
});

describe('WorkMemoryService.recall', () => {
    it('returns prior findings scoped to this Work', async () => {
        const facade = makeFacade();
        const service = new WorkMemoryService(facade as never);

        const results = await service.recall({
            work: { id: 'work-1' } as never,
            userId: 'user-1',
            query: 'what did we learn about pricing',
        });

        expect(results).toEqual([{ content: 'prior finding', score: 0.9 }]);
        expect(facade.searchMemory.mock.calls[0][0]).toMatchObject({
            tags: ['work:work-1'],
            limit: 10,
        });
    });

    it('returns an empty list rather than throwing when no provider exists', async () => {
        const service = new WorkMemoryService(undefined);
        await expect(
            service.recall({ work: { id: 'work-1' } as never, userId: 'u', query: 'q' }),
        ).resolves.toEqual([]);
    });

    it('returns an empty list when the provider errors', async () => {
        const facade = makeFacade({
            searchMemory: jest.fn().mockRejectedValue(new Error('down')),
        });
        const service = new WorkMemoryService(facade as never);

        await expect(
            service.recall({ work: { id: 'work-1' } as never, userId: 'u', query: 'q' }),
        ).resolves.toEqual([]);
    });

    it('tolerates a provider returning no results field', async () => {
        const facade = makeFacade({ searchMemory: jest.fn().mockResolvedValue({}) });
        const service = new WorkMemoryService(facade as never);

        await expect(
            service.recall({ work: { id: 'work-1' } as never, userId: 'u', query: 'q' }),
        ).resolves.toEqual([]);
    });
});
