import { GitFacadeService, GitOperationNotSupportedError } from '../git.facade';

/**
 * PR insights (kanban run cockpit M5/M6) — facade-side contract for the
 * two OPTIONAL git-provider capabilities.
 *
 * The load-bearing assertions are about ABSENCE. Both methods are
 * optional on `IGitProviderPlugin`, and the lazy-plugin proxy in this
 * codebase over-reports optional methods (the known gotcha plan 04 §7.7
 * names). So the facade must:
 *
 *  - materialise the method off the resolved plugin and verify it is
 *    callable BEFORE calling, and
 *  - raise a typed `GitOperationNotSupportedError` (→ HTTP 409 via
 *    `FacadeExceptionFilter`) rather than letting a TypeError become an
 *    unmapped 500.
 */

const OPTIONS = { providerId: 'github', userId: 'user-1', workId: 'work-1' } as const;

const DIFF = {
    files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0 }],
    truncated: false,
    totalFiles: 1,
    totalAdditions: 1,
    totalDeletions: 0,
    patchBytes: 0,
};

const STATUS = {
    number: 41,
    state: 'open' as const,
    merged: false,
    ciState: 'passing' as const,
    checks: [],
};

function makeFacade(plugin: Record<string, unknown>) {
    const facade = new GitFacadeService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
    );
    (
        facade as unknown as {
            resolvePluginAndToken: () => Promise<{ plugin: unknown; token: string }>;
        }
    ).resolvePluginAndToken = jest
        .fn()
        .mockResolvedValue({ plugin: { id: 'github', ...plugin }, token: 'tok' });
    return facade;
}

describe('GitFacadeService — PR insights capabilities', () => {
    describe('getPullRequestStatus', () => {
        it('delegates to the provider with the resolved token', async () => {
            const getPullRequestStatus = jest.fn().mockResolvedValue(STATUS);
            const facade = makeFacade({ getPullRequestStatus });

            await expect(
                facade.getPullRequestStatus('acme', 'widgets', 41, OPTIONS),
            ).resolves.toEqual(STATUS);
            expect(getPullRequestStatus).toHaveBeenCalledWith('acme', 'widgets', 41, 'tok');
        });

        it('passes a provider `null` (deleted PR) straight through', async () => {
            const facade = makeFacade({
                getPullRequestStatus: jest.fn().mockResolvedValue(null),
            });
            await expect(
                facade.getPullRequestStatus('acme', 'widgets', 41, OPTIONS),
            ).resolves.toBeNull();
        });

        it('raises GitOperationNotSupportedError when the provider omits it', async () => {
            const facade = makeFacade({});
            await expect(
                facade.getPullRequestStatus('acme', 'widgets', 41, OPTIONS),
            ).rejects.toBeInstanceOf(GitOperationNotSupportedError);
        });

        it('raises it for a proxy that reports a non-function member', async () => {
            const facade = makeFacade({ getPullRequestStatus: undefined });
            await expect(
                facade.getPullRequestStatus('acme', 'widgets', 41, OPTIONS),
            ).rejects.toMatchObject({ name: 'GitOperationNotSupportedError' });
        });
    });

    describe('getPullRequestDiff', () => {
        it('forwards the caps verbatim to the provider', async () => {
            const getPullRequestDiff = jest.fn().mockResolvedValue(DIFF);
            const facade = makeFacade({ getPullRequestDiff });

            await facade.getPullRequestDiff(
                'acme',
                'widgets',
                41,
                { maxBytes: 1024, maxFiles: 10 },
                OPTIONS,
            );

            expect(getPullRequestDiff).toHaveBeenCalledWith(
                'acme',
                'widgets',
                41,
                { maxBytes: 1024, maxFiles: 10 },
                'tok',
            );
        });

        it('raises GitOperationNotSupportedError when the provider omits it', async () => {
            const facade = makeFacade({});
            await expect(
                facade.getPullRequestDiff('acme', 'widgets', 41, undefined, OPTIONS),
            ).rejects.toBeInstanceOf(GitOperationNotSupportedError);
        });

        it('names the operation and the provider on the error', async () => {
            const facade = makeFacade({});
            await expect(
                facade.getPullRequestDiff('acme', 'widgets', 41, undefined, OPTIONS),
            ).rejects.toMatchObject({
                operation: 'getPullRequestDiff',
                provider: 'github',
            });
        });
    });

    describe('getCompareDiff', () => {
        it('delegates base...head with the caps', async () => {
            const getCompareDiff = jest.fn().mockResolvedValue(DIFF);
            const facade = makeFacade({ getCompareDiff });

            await facade.getCompareDiff(
                'acme',
                'widgets',
                'main',
                'task/t-1',
                { maxFiles: 3 },
                OPTIONS,
            );

            expect(getCompareDiff).toHaveBeenCalledWith(
                'acme',
                'widgets',
                'main',
                'task/t-1',
                { maxFiles: 3 },
                'tok',
            );
        });

        it('raises GitOperationNotSupportedError when the provider omits it', async () => {
            const facade = makeFacade({ getPullRequestDiff: jest.fn() });
            await expect(
                facade.getCompareDiff('acme', 'widgets', 'main', 'x', undefined, OPTIONS),
            ).rejects.toBeInstanceOf(GitOperationNotSupportedError);
        });
    });
});
