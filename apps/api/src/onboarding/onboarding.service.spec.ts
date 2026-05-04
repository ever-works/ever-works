import { canonicaliseRepoUrl, OnboardingService, parseRepoCoords } from './onboarding.service';

jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    OnboardingRequest: class OnboardingRequest {},
    WebhookSubscription: class WebhookSubscription {},
}));

describe('canonicaliseRepoUrl', () => {
    it('lowercases owner and repo and strips .git', () => {
        expect(canonicaliseRepoUrl('https://github.com/Octocat/Awesome-MCP.git')).toBe(
            'https://github.com/octocat/awesome-mcp',
        );
    });

    it('strips trailing slash', () => {
        expect(canonicaliseRepoUrl('https://github.com/octocat/awesome/')).toBe(
            'https://github.com/octocat/awesome',
        );
    });

    it('rejects non-github hosts', () => {
        expect(canonicaliseRepoUrl('https://gitlab.com/x/y')).toBeNull();
    });

    it('rejects malformed URLs', () => {
        expect(canonicaliseRepoUrl('not a url')).toBeNull();
    });

    it('rejects URLs missing repo segment', () => {
        expect(canonicaliseRepoUrl('https://github.com/octocat')).toBeNull();
    });
});

describe('parseRepoCoords', () => {
    it('returns owner and repo for valid URLs', () => {
        expect(parseRepoCoords('https://github.com/Octocat/Awesome-MCP')).toEqual({
            owner: 'octocat',
            repo: 'awesome-mcp',
            canonicalUrl: 'https://github.com/octocat/awesome-mcp',
        });
    });
});

describe('OnboardingService', () => {
    const validBody = {
        repo: 'https://github.com/Octocat/Awesome-MCP',
    };

    const validManifestYaml = `
apiVersion: works.ever.works/v1
kind: Work
metadata:
  name: My Awesome Set
spec:
  pipeline: standard-pipeline
  domain: software
  items:
    sources:
      - type: web-search
        query: x
`;

    const fakeRepository = () => ({
        findOne: jest.fn(),
        create: jest.fn((x) => x),
        save: jest.fn(async (x) => ({ ...x, id: 'onboard-1' })),
    });

    const fakeManifestService = () => ({
        parseAndValidate: jest.fn().mockReturnValue({
            kind: 'success',
            ok: true,
            manifest: {
                apiVersion: 'works.ever.works/v1',
                kind: 'Work',
                metadata: { name: 'My Awesome Set', slug: 'my-awesome-set' },
                spec: {
                    pipeline: 'standard-pipeline',
                    domain: 'software',
                    items: { sources: [{ type: 'web-search', query: 'x' }] },
                },
            },
        }),
    });

    const fakeGitFacade = () => ({
        getUser: jest.fn().mockResolvedValue({ id: 12345, login: 'octocat' }),
        getRepository: jest.fn().mockResolvedValue({
            id: 999,
            name: 'awesome-mcp',
            permissions: { push: true, admin: false },
        }),
        getFileContent: jest.fn().mockResolvedValue({
            content: Buffer.from(validManifestYaml).toString('base64'),
            encoding: 'base64',
        }),
    });

    const fakeOnboardingRowRepo = () => ({
        findById: jest.fn(),
        setAccountId: jest.fn().mockResolvedValue(undefined),
        setWorkId: jest.fn().mockResolvedValue(undefined),
        tryTransition: jest.fn().mockResolvedValue(true),
        markFailure: jest.fn().mockResolvedValue(undefined),
    });

    const fakeAccountUpsert = () => ({
        upsertFromGithub: jest.fn().mockResolvedValue({ accountId: 'acc-1' }),
    });

    const fakeWorkCreator = () => ({
        createFromManifest: jest.fn().mockResolvedValue({ workId: 'work-1' }),
    });

    const createService = (
        overrides: {
            repo?: ReturnType<typeof fakeRepository>;
            manifest?: ReturnType<typeof fakeManifestService>;
            git?: ReturnType<typeof fakeGitFacade>;
            rowRepo?: ReturnType<typeof fakeOnboardingRowRepo>;
            account?: ReturnType<typeof fakeAccountUpsert>;
            workCreator?: ReturnType<typeof fakeWorkCreator>;
        } = {},
    ) => {
        const repo = overrides.repo ?? fakeRepository();
        const manifest = overrides.manifest ?? fakeManifestService();
        const git = overrides.git ?? fakeGitFacade();
        const rowRepo = overrides.rowRepo ?? fakeOnboardingRowRepo();
        const account = overrides.account ?? fakeAccountUpsert();
        const workCreator = overrides.workCreator ?? fakeWorkCreator();
        const service = new OnboardingService(
            repo as any,
            manifest as any,
            git as any,
            rowRepo as any,
            account as any,
            workCreator as any,
        );
        return { service, repo, manifest, git, rowRepo, account, workCreator };
    };

    it('returns existing onboardingId when same identity reuses same repo (idempotency)', async () => {
        const repo = fakeRepository();
        repo.findOne.mockResolvedValueOnce({
            id: 'existing-id',
            workId: 'work-1',
            status: 'queued',
            subdomain: 'my-dir',
            githubIdentityHash: 'h',
            repoUrlCanonical: 'https://github.com/octocat/awesome-mcp',
        });

        const { service } = createService({ repo });
        const result = await service.handle({
            body: validBody as any,
            githubToken: 'token-aaaa',
        });

        expect(result.onboardingId).toBe('existing-id');
        expect(result.workId).toBe('work-1');
        expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects with repo_already_owned when a different identity owns the repo', async () => {
        const repo = fakeRepository();
        repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
            id: 'other-id',
            githubIdentityHash: 'different-hash',
            repoUrlCanonical: 'https://github.com/octocat/awesome-mcp',
        });

        const { service } = createService({ repo });
        await expect(
            service.handle({ body: validBody as any, githubToken: 'token-aaaa' }),
        ).rejects.toMatchObject({
            response: { code: 'repo_already_owned' },
        });
    });

    it('persists, upserts the account, creates the Work and transitions to queued on the happy path', async () => {
        const repo = fakeRepository();
        repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

        const { service, git, manifest, account, workCreator, rowRepo } = createService({ repo });
        const result = await service.handle({
            body: { ...validBody, subdomain: 'my-dir', email: 'owner@example.com' } as any,
            githubToken: 'token-aaaa',
            idempotencyKey: 'idem-1',
        });

        expect(repo.save).toHaveBeenCalled();
        const saved = repo.save.mock.calls[0][0];
        expect(saved.status).toBe('validated');
        expect(saved.subdomain).toBe('my-dir');
        expect(saved.idempotencyKey).toBe('idem-1');

        expect(git.getUser).toHaveBeenCalledWith({ providerId: 'github', token: 'token-aaaa' });
        expect(git.getRepository).toHaveBeenCalledWith(
            'octocat',
            'awesome-mcp',
            expect.objectContaining({ token: 'token-aaaa' }),
        );
        expect(git.getFileContent).toHaveBeenCalledWith(
            'octocat',
            'awesome-mcp',
            'works.yml',
            expect.objectContaining({ token: 'token-aaaa' }),
        );
        expect(manifest.parseAndValidate).toHaveBeenCalled();

        expect(account.upsertFromGithub).toHaveBeenCalledWith(
            expect.objectContaining({
                login: 'octocat',
                email: 'owner@example.com',
                accessToken: 'token-aaaa',
            }),
        );
        expect(rowRepo.setAccountId).toHaveBeenCalledWith('onboard-1', 'acc-1');

        expect(workCreator.createFromManifest).toHaveBeenCalledWith(
            expect.objectContaining({
                accountId: 'acc-1',
                githubAccessToken: 'token-aaaa',
                manifestRepoUrl: 'https://github.com/octocat/awesome-mcp',
                onboardingId: 'onboard-1',
                subdomain: 'my-dir',
            }),
        );
        expect(rowRepo.setWorkId).toHaveBeenCalledWith('onboard-1', 'work-1');
        expect(rowRepo.tryTransition).toHaveBeenCalledWith('onboard-1', 'validated', 'queued', {
            workId: 'work-1',
        });

        expect(result.status).toBe('queued');
        expect(result.workId).toBe('work-1');
        expect(result.subdomain).toBe('my-dir.ever.works');
    });

    it('marks the row failed with work_creation_failed when the work creator throws', async () => {
        const repo = fakeRepository();
        repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        const workCreator = fakeWorkCreator();
        workCreator.createFromManifest.mockRejectedValueOnce(new Error('repo conflict'));

        const { service, rowRepo } = createService({ repo, workCreator });
        const result = await service.handle({ body: validBody as any, githubToken: 'token-aaaa' });

        expect(rowRepo.markFailure).toHaveBeenCalledWith(
            'onboard-1',
            'work_creation_failed',
            expect.objectContaining({ message: 'repo conflict' }),
        );
        expect(result.status).toBe('failed');
    });

    it('still returns 202 when account upsert fails — the row remains validated for a reconciler', async () => {
        const repo = fakeRepository();
        repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        const account = fakeAccountUpsert();
        account.upsertFromGithub.mockRejectedValueOnce(new Error('db down'));
        const workCreator = fakeWorkCreator();

        const { service } = createService({ repo, account, workCreator });
        const result = await service.handle({ body: validBody as any, githubToken: 'token-aaaa' });

        expect(workCreator.createFromManifest).not.toHaveBeenCalled();
        expect(result.status).toBe('validated');
    });

    it('falls back to manifest slug when no subdomain hint is provided', async () => {
        const repo = fakeRepository();
        repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

        const { service } = createService({ repo });
        await service.handle({ body: validBody as any, githubToken: 'token-aaaa' });

        const saved = repo.save.mock.calls[0][0];
        expect(saved.subdomain).toBe('my-awesome-set');
    });

    it('rejects with gh_credential_invalid when GitHub token resolution fails', async () => {
        const repo = fakeRepository();
        const git = fakeGitFacade();
        git.getUser.mockRejectedValueOnce(new Error('401 bad credentials'));

        const { service } = createService({ repo, git });
        await expect(
            service.handle({ body: validBody as any, githubToken: 'token-aaaa' }),
        ).rejects.toMatchObject({ response: { code: 'gh_credential_invalid' } });
        expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejects with gh_repo_access_denied when getRepository returns null', async () => {
        const repo = fakeRepository();
        repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        const git = fakeGitFacade();
        git.getRepository.mockResolvedValueOnce(null);

        const { service } = createService({ repo, git });
        await expect(
            service.handle({ body: validBody as any, githubToken: 'token-aaaa' }),
        ).rejects.toMatchObject({ response: { code: 'gh_repo_access_denied' } });
    });

    it('rejects with gh_repo_access_denied when token lacks write access', async () => {
        const repo = fakeRepository();
        repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        const git = fakeGitFacade();
        git.getRepository.mockResolvedValueOnce({
            id: 1,
            name: 'awesome-mcp',
            permissions: { pull: true, push: false, admin: false },
        });

        const { service } = createService({ repo, git });
        await expect(
            service.handle({ body: validBody as any, githubToken: 'token-aaaa' }),
        ).rejects.toMatchObject({ response: { code: 'gh_repo_access_denied' } });
    });

    it('rejects with manifest_missing when works.yml is not present', async () => {
        const repo = fakeRepository();
        repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        const git = fakeGitFacade();
        git.getFileContent.mockResolvedValue(null);

        const { service } = createService({ repo, git });
        await expect(
            service.handle({ body: validBody as any, githubToken: 'token-aaaa' }),
        ).rejects.toMatchObject({ response: { code: 'manifest_missing' } });
    });

    it('rejects with manifest_invalid when schema validation fails', async () => {
        const repo = fakeRepository();
        repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        const manifest = fakeManifestService();
        manifest.parseAndValidate.mockReturnValueOnce({
            kind: 'failure',
            ok: false,
            code: 'manifest_invalid',
            errors: [
                {
                    path: 'spec.domain',
                    message: 'Invalid enum value',
                    subcode: 'manifest.spec.domain_invalid',
                },
            ],
        });

        const { service } = createService({ repo, manifest });
        await expect(
            service.handle({ body: validBody as any, githubToken: 'token-aaaa' }),
        ).rejects.toMatchObject({
            response: {
                code: 'manifest_invalid',
                errors: [expect.objectContaining({ path: 'spec.domain' })],
            },
        });
    });

    it('falls back to .yaml extension when works.yml is absent but works.yaml exists', async () => {
        const repo = fakeRepository();
        repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        const git = fakeGitFacade();
        git.getFileContent.mockResolvedValueOnce(null).mockResolvedValueOnce({
            content: Buffer.from(validManifestYaml).toString('base64'),
            encoding: 'base64',
        });

        const { service } = createService({ repo, git });
        await service.handle({ body: validBody as any, githubToken: 'token-aaaa' });

        expect(git.getFileContent).toHaveBeenNthCalledWith(
            1,
            'octocat',
            'awesome-mcp',
            'works.yml',
            expect.anything(),
        );
        expect(git.getFileContent).toHaveBeenNthCalledWith(
            2,
            'octocat',
            'awesome-mcp',
            'works.yaml',
            expect.anything(),
        );
    });

    it('rejects when token is empty', async () => {
        const { service } = createService();
        await expect(
            service.handle({ body: validBody as any, githubToken: '' }),
        ).rejects.toMatchObject({ response: { code: 'gh_credential_invalid' } });
    });

    it('getStatus rejects when token does not match the row owner', async () => {
        const repo = fakeRepository();
        repo.findOne.mockResolvedValueOnce({
            id: 'r1',
            githubIdentityHash: 'expected-hash',
            repoUrlCanonical: 'https://github.com/o/r',
            status: 'validated',
            workId: null,
            subdomain: null,
        });

        const { service } = createService({ repo });
        await expect(service.getStatus('r1', 'token-aaaa')).rejects.toMatchObject({
            response: { code: 'gh_repo_access_denied' },
        });
    });

    it('getStatus returns the row when token matches', async () => {
        const repo = fakeRepository();
        const git = fakeGitFacade();
        const expectedHash = require('node:crypto')
            .createHash('sha256')
            .update('github:12345')
            .digest('hex');
        repo.findOne.mockResolvedValueOnce({
            id: 'r1',
            githubIdentityHash: expectedHash,
            repoUrlCanonical: 'https://github.com/o/r',
            status: 'validated',
            workId: null,
            subdomain: 'my-dir',
        });

        const { service } = createService({ repo, git });
        const result = await service.getStatus('r1', 'token-aaaa');
        expect(result.onboardingId).toBe('r1');
        expect(result.subdomain).toBe('my-dir.ever.works');
    });
});
