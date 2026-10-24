import { requestGitHubAppInstallationAccessTokenDetails } from '@src/utils';

import { GitFacadeService } from '../git.facade';

jest.mock('@src/utils', () => ({
    requestGitHubAppInstallationAccessTokenDetails: jest.fn(),
}));

/**
 * Security (sec/app-works-gates, 2026-10-18) — `GitFacadeService.getWorkInstallationPackagesReadToken`.
 *
 * The App Works image-pull fallback used to put `getAccessToken`'s answer into the target cluster:
 * for an App-linked Work that is an installation token with EVERY permission the App holds. This
 * method mints the same installation's token with `permissions: { packages: 'read' }` only, and
 * answers `null` (never throws) whenever that is not possible, so the caller can fall back.
 */

const OPTIONS = { providerId: 'github', userId: 'user-1', workId: 'work-1' } as const;
const mint = jest.mocked(requestGitHubAppInstallationAccessTokenDetails);

function makeFacade(work: unknown, installation: unknown) {
    const works = { findById: jest.fn(async () => work) };
    const installations = { findByInstallationId: jest.fn(async () => installation) };
    const facade = new GitFacadeService(
        {} as never,
        {} as never,
        {} as never,
        works as never,
        installations as never,
    );
    return { facade, works, installations };
}

const LINKED = {
    id: 'work-1',
    sourceRepository: { auth: { mode: 'github_app_installation', installationId: 'inst-1' } },
};
const ACTIVE = { installationId: 'inst-1', deletedAt: null, suspendedAt: null };

describe('GitFacadeService.getWorkInstallationPackagesReadToken (sec/app-works-gates)', () => {
    const saved = { id: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY };

    beforeEach(() => {
        mint.mockReset();
        process.env.GITHUB_APP_ID = 'app-1';
        process.env.GITHUB_APP_PRIVATE_KEY = 'pem-placeholder';
    });

    afterAll(() => {
        if (saved.id === undefined) delete process.env.GITHUB_APP_ID;
        else process.env.GITHUB_APP_ID = saved.id;
        if (saved.key === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
        else process.env.GITHUB_APP_PRIVATE_KEY = saved.key;
    });

    it('mints the installation token with packages:read ONLY', async () => {
        mint.mockResolvedValue({ token: 'ghs_packages_read', expiresAt: null });
        const { facade } = makeFacade(LINKED, ACTIVE);

        await expect(facade.getWorkInstallationPackagesReadToken(OPTIONS)).resolves.toBe(
            'ghs_packages_read',
        );
        expect(mint).toHaveBeenCalledTimes(1);
        expect(mint).toHaveBeenCalledWith(
            'inst-1',
            { appId: 'app-1', privateKey: 'pem-placeholder' },
            { permissions: { packages: 'read' } },
        );
        // Exactly one permission: nothing else may be granted.
        expect(Object.keys(mint.mock.calls[0][2]?.permissions ?? {})).toEqual(['packages']);
    });

    it('is never cached (the shared cache holds the unscoped token)', async () => {
        mint.mockResolvedValue({ token: 'ghs_packages_read', expiresAt: null });
        const { facade } = makeFacade(LINKED, ACTIVE);

        await facade.getWorkInstallationPackagesReadToken(OPTIONS);
        await facade.getWorkInstallationPackagesReadToken(OPTIONS);

        expect(mint).toHaveBeenCalledTimes(2);
    });

    it('answers null without minting for a Work that is not App-linked, or a non-GitHub provider', async () => {
        for (const work of [
            null,
            { id: 'work-1' },
            { id: 'work-1', sourceRepository: { auth: { mode: 'oauth' } } },
            { id: 'work-1', sourceRepository: { auth: { mode: 'github_app_installation' } } },
        ]) {
            const { facade } = makeFacade(work, ACTIVE);
            await expect(facade.getWorkInstallationPackagesReadToken(OPTIONS)).resolves.toBeNull();
        }

        const { facade } = makeFacade(LINKED, ACTIVE);
        await expect(
            facade.getWorkInstallationPackagesReadToken({ ...OPTIONS, providerId: 'gitlab' }),
        ).resolves.toBeNull();
        await expect(
            facade.getWorkInstallationPackagesReadToken({ providerId: 'github', userId: 'user-1' }),
        ).resolves.toBeNull();
        expect(mint).not.toHaveBeenCalled();
    });

    it('answers null for a deleted or suspended installation, or unset App credentials', async () => {
        for (const installation of [
            null,
            { ...ACTIVE, deletedAt: new Date() },
            { ...ACTIVE, suspendedAt: new Date() },
        ]) {
            const { facade } = makeFacade(LINKED, installation);
            await expect(facade.getWorkInstallationPackagesReadToken(OPTIONS)).resolves.toBeNull();
        }

        delete process.env.GITHUB_APP_PRIVATE_KEY;
        const { facade } = makeFacade(LINKED, ACTIVE);
        await expect(facade.getWorkInstallationPackagesReadToken(OPTIONS)).resolves.toBeNull();
        expect(mint).not.toHaveBeenCalled();
    });

    it('answers null — never throws — when GitHub refuses the narrowed mint (the App lacks Packages: read)', async () => {
        mint.mockRejectedValue(
            new Error('Failed to create GitHub App installation token: 422 Unprocessable Entity'),
        );
        const { facade } = makeFacade(LINKED, ACTIVE);

        await expect(facade.getWorkInstallationPackagesReadToken(OPTIONS)).resolves.toBeNull();
    });
});
