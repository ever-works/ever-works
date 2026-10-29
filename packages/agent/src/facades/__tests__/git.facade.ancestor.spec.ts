import { GitFacadeService } from '../git.facade';

/**
 * APW-08 T8 — `GitFacadeService.isAncestorCommit`: a pass-through to the
 * provider, and `null` ("cannot say") for a provider without the method, so
 * the App Works delivery reconciler falls back to exact-sha matching instead
 * of failing (plan §7, §8.2).
 */

const OPTIONS = { providerId: 'github', userId: 'user-1', workId: 'work-1' } as const;

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

describe('GitFacadeService — isAncestorCommit (APW-08 T8)', () => {
    it('passes the provider answer through with the resolved token', async () => {
        const isAncestorCommit = jest.fn().mockResolvedValue(true);
        const facade = makeFacade({ isAncestorCommit });

        await expect(
            facade.isAncestorCommit('acme', 'bookings', 'merge-sha', 'later-sha', OPTIONS),
        ).resolves.toBe(true);
        expect(isAncestorCommit).toHaveBeenCalledWith(
            'acme',
            'bookings',
            'merge-sha',
            'later-sha',
            'tok',
        );
    });

    it.each([false, null])('passes a provider %s through unchanged', async (answer) => {
        const facade = makeFacade({ isAncestorCommit: jest.fn().mockResolvedValue(answer) });
        await expect(
            facade.isAncestorCommit('acme', 'bookings', 'a', 'b', OPTIONS),
        ).resolves.toBe(answer);
    });

    it('answers null — never throws — for a provider without the method', async () => {
        const facade = makeFacade({});
        await expect(
            facade.isAncestorCommit('acme', 'bookings', 'a', 'b', OPTIONS),
        ).resolves.toBeNull();
    });

    it('answers null for a lazy proxy that reports a non-function member', async () => {
        const facade = makeFacade({ isAncestorCommit: undefined });
        await expect(
            facade.isAncestorCommit('acme', 'bookings', 'a', 'b', OPTIONS),
        ).resolves.toBeNull();
    });
});
