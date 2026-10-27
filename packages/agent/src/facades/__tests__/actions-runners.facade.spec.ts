import {
    actionsRunnersGrantUrl,
    actionsRunnersPermissionLabel,
    actionsRunnersPermissionsFor,
    ActionsRunnersFacadeError,
    ActionsRunnersFacadeService,
} from '../actions-runners.facade';

/**
 * Actions runners on computers (FL-18, T-07, plan §3, §7) — the facade: the
 * narrowest permission per operation, repository ids only from the platform's
 * own snapshot, the ownership filter (created by this person, neither
 * suspended nor deleted), and a refused narrowed mint named as the exact
 * permission with the installation's page.
 */

const OWNER = 'owner-1';

function installation(overrides: Record<string, unknown> = {}) {
    return {
        id: 'inst-row-1',
        installationId: '4242',
        accountLogin: 'acme',
        targetType: 'Organization',
        createdByUserId: OWNER,
        suspendedAt: null,
        deletedAt: null,
        ...overrides,
    };
}

function facade(
    rows: Array<Record<string, unknown>>,
    repos: Record<string, Array<Record<string, unknown>>> = {},
) {
    const installations = { listByCreatedByUserId: jest.fn(async () => rows) };
    const installationRepos = {
        listForInstallation: jest.fn(async (id: string) => repos[id] ?? []),
    };
    const service = new ActionsRunnersFacadeService(
        {} as never,
        {} as never,
        undefined,
        installations as never,
        installationRepos as never,
    );
    const minted: Array<{ installationId: string; scope: unknown }> = [];
    let refuse: string | null = null;
    (service as unknown as { minter: unknown }).minter = async (
        installationId: string,
        _credentials: unknown,
        scope: unknown,
    ) => {
        if (refuse) throw new Error(refuse);
        minted.push({ installationId, scope });
        return { token: 'ghs_short_lived', expiresAt: '2026-10-26T11:00:00Z' };
    };
    return { service, minted, refuseWith: (message: string) => (refuse = message) };
}

describe('ActionsRunnersFacadeService (FL-18 P1)', () => {
    const saved = { ...process.env };
    beforeEach(() => {
        process.env.GITHUB_APP_ID = '123';
        process.env.GITHUB_APP_PRIVATE_KEY = 'test-key';
    });
    afterEach(() => {
        process.env = { ...saved };
    });

    it('names the narrowest permission per operation', () => {
        expect(actionsRunnersPermissionsFor('repo', 'runners-read')).toEqual({
            administration: 'read',
        });
        expect(actionsRunnersPermissionsFor('repo', 'runners-write')).toEqual({
            administration: 'write',
        });
        expect(actionsRunnersPermissionsFor('org', 'runners-read')).toEqual({
            organization_self_hosted_runners: 'read',
        });
        expect(actionsRunnersPermissionsFor('org', 'runners-write')).toEqual({
            organization_self_hosted_runners: 'write',
        });
        expect(actionsRunnersPermissionsFor('repo', 'jobs-read')).toEqual({ actions: 'read' });
        expect(actionsRunnersPermissionsFor('org', 'runs-write')).toEqual({ actions: 'write' });
        expect(actionsRunnersPermissionLabel('org', 'runners-write')).toBe(
            'Self-hosted runners: Read and write',
        );
        expect(actionsRunnersPermissionLabel('repo', 'runners-write')).toBe(
            'Administration: Read and write',
        );
    });

    it('lists only the targets of live installations this person created', async () => {
        const { service } = facade(
            [
                installation(),
                installation({ id: 'gone', accountLogin: 'old', deletedAt: new Date() }),
                installation({ id: 'paused', accountLogin: 'paused', suspendedAt: new Date() }),
                installation({
                    id: 'theirs',
                    accountLogin: 'theirs',
                    createdByUserId: 'someone-else',
                }),
            ],
            {
                'inst-row-1': [
                    { fullName: 'acme/api', githubRepoId: '7', selected: true },
                    { fullName: 'acme/unselected', githubRepoId: '8', selected: false },
                ],
                gone: [{ fullName: 'old/repo', githubRepoId: '9' }],
            },
        );
        const targets = await service.listTargets(OWNER);
        expect(targets.map((target) => `${target.scope}:${target.target}`)).toEqual([
            'repo:acme/api',
            'org:acme',
        ]);
        expect(targets[0].repositoryId).toBe('7');
    });

    it('refuses a target no live installation covers (U7)', async () => {
        const { service } = facade([installation()], {
            'inst-row-1': [{ fullName: 'acme/api', githubRepoId: '7' }],
        });
        await expect(service.resolveTarget(OWNER, 'repo', 'other/repo')).rejects.toMatchObject({
            reason: 'not-covered',
        });
    });

    it('narrows a repository token to that repository’s id from the snapshot, an organisation token to its permission', async () => {
        const { service, minted } = facade([installation()], {
            'inst-row-1': [{ fullName: 'acme/api', githubRepoId: '7' }],
        });
        const repo = await service.resolveTarget(OWNER, 'repo', 'ACME/api');
        await service.mintToken(repo, 'runners-write');
        const org = await service.resolveTarget(OWNER, 'org', 'acme');
        await service.mintToken(org, 'runners-write');
        expect(minted).toEqual([
            {
                installationId: '4242',
                scope: { permissions: { administration: 'write' }, repositoryIds: ['7'] },
            },
            {
                installationId: '4242',
                scope: { permissions: { organization_self_hosted_runners: 'write' } },
            },
        ]);
    });

    it('turns a refused narrowed mint into the exact permission and the installation page (U8)', async () => {
        const { service, refuseWith } = facade([installation()]);
        const org = await service.resolveTarget(OWNER, 'org', 'acme');
        refuseWith('GitHub answered 422 for the installation token');
        const error = await service
            .mintToken(org, 'runners-write')
            .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(ActionsRunnersFacadeError);
        expect(error).toMatchObject({
            reason: 'permission-missing',
            extra: {
                missing: 'Self-hosted runners: Read and write',
                grantUrl: 'https://github.com/organizations/acme/settings/installations/4242',
            },
        });
        expect(String((error as Error).message)).not.toContain('ghs_');
        expect(
            actionsRunnersGrantUrl({ installationId: '1', accountLogin: 'me', targetType: 'User' }),
        ).toBe('https://github.com/settings/installations/1');
    });

    it('mints nothing without the deployment’s GitHub App credentials', async () => {
        delete process.env.GITHUB_APP_ID;
        const { service, minted } = facade([installation()]);
        const org = await service.resolveTarget(OWNER, 'org', 'acme');
        await expect(service.mintToken(org, 'runners-read')).rejects.toMatchObject({
            reason: 'not-configured',
        });
        expect(minted).toHaveLength(0);
    });
});
