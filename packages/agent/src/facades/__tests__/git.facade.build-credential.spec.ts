import { GitFacadeService } from '../git.facade';

/**
 * 2026-10-17 (lane aw-builds-2) — `GitFacadeService.getBuildCredential`.
 *
 * A Build commits `.github/workflows/ever-works-build.yml`, which GitHub only lets
 * an OAuth token write with the `workflow` scope and a GitHub App installation
 * with `Workflows: write`. The ladder prefers a credential that can, and says
 * which kind it returned so the plugin can refuse with a named reason.
 */

const OPTIONS = { providerId: 'github', userId: 'user-1', workId: 'work-1' } as const;

type Internals = {
    resolvePlugin: (providerId: string, userId?: string, workId?: string) => Promise<unknown>;
    getInstallationTokenForWork: (options: unknown) => Promise<string | null>;
    getPatFromSettings: (pluginId: string, userId: string, workId?: string) => Promise<string | null>;
};

function makeFacade(accounts: {
    workflow?: { accessToken: string; scope: string } | null;
    repoOnly?: { accessToken: string; scope: string } | null;
}) {
    const authAccountRepository = {
        findConnectedProviderAccount: jest.fn(
            async (_userId: string, _pluginId: string, options: { requiredScopes?: string[] }) =>
                (options.requiredScopes ?? []).includes('workflow')
                    ? (accounts.workflow ?? null)
                    : (accounts.repoOnly ?? null),
        ),
        findProviderAccount: jest.fn(async () => null),
    };
    const facade = new GitFacadeService(
        {} as never,
        authAccountRepository as never,
        { getResolvedSettings: jest.fn(async () => ({})) } as never,
        { findById: jest.fn(async () => null) } as never,
        {} as never,
    );
    const internals = facade as unknown as Internals;
    jest.spyOn(internals, 'resolvePlugin').mockResolvedValue({ id: 'github' });
    const installation = jest.spyOn(internals, 'getInstallationTokenForWork').mockResolvedValue(null);
    const pat = jest.spyOn(internals, 'getPatFromSettings').mockResolvedValue(null);
    return { facade, authAccountRepository, installation, pat };
}

describe('GitFacadeService.getBuildCredential', () => {
    it('prefers a connected account WITH the workflow scope, and says so', async () => {
        const h = makeFacade({
            workflow: { accessToken: 'gho_workflow', scope: 'repo,workflow,read:user' },
            repoOnly: { accessToken: 'gho_repo', scope: 'repo' },
        });
        h.installation.mockResolvedValue('ghs_installation');

        await expect(h.facade.getBuildCredential(OPTIONS)).resolves.toEqual({
            token: 'gho_workflow',
            credential: 'oauth',
            scopes: ['repo', 'workflow', 'read:user'],
        });
        expect(h.authAccountRepository.findConnectedProviderAccount).toHaveBeenCalledWith(
            'user-1',
            'github',
            expect.objectContaining({ requiredScopes: ['repo', 'workflow'] }),
        );
    });

    it('falls back to the installation token, then a repo-only account, then a PAT — each named', async () => {
        const app = makeFacade({ repoOnly: { accessToken: 'gho_repo', scope: 'repo' } });
        app.installation.mockResolvedValue('ghs_installation');
        await expect(app.facade.getBuildCredential(OPTIONS)).resolves.toEqual({
            token: 'ghs_installation',
            credential: 'githubApp',
            scopes: null,
        });

        const repoOnly = makeFacade({ repoOnly: { accessToken: 'gho_repo', scope: 'repo read:user' } });
        await expect(repoOnly.facade.getBuildCredential(OPTIONS)).resolves.toEqual({
            token: 'gho_repo',
            credential: 'oauth',
            scopes: ['repo', 'read:user'],
        });

        const pat = makeFacade({});
        pat.pat.mockResolvedValue('ghp_pat');
        await expect(pat.facade.getBuildCredential(OPTIONS)).resolves.toEqual({
            token: 'ghp_pat',
            credential: 'pat',
            scopes: null,
        });
    });

    it('answers null with no credential, and never throws', async () => {
        const none = makeFacade({});
        await expect(none.facade.getBuildCredential(OPTIONS)).resolves.toBeNull();
        await expect(none.facade.getBuildCredential({ providerId: 'github', userId: '' } as never)).resolves.toBeNull();

        const broken = makeFacade({});
        jest.spyOn(broken.facade as unknown as Internals, 'resolvePlugin').mockRejectedValue(new Error('no plugin'));
        await expect(broken.facade.getBuildCredential(OPTIONS)).resolves.toBeNull();
    });
});
