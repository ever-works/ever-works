// Stub the disk-touching surfaces of `fs` so the suite never actually
// writes/reads. We use `jest.requireActual('fs')` + spread to preserve the
// rest of the API — replacing the whole module with bare jest.fn()s breaks
// typeorm's loader (which uses glob/path-scurry, which probes fs internals
// like `realpath.native`). Spreading actual keeps those intact.
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        writeFileSync: jest.fn(),
        readFileSync: jest.fn(),
        existsSync: jest.fn(),
        mkdirSync: jest.fn(),
        readdirSync: jest.fn(),
    };
});

import * as fs from 'fs';
import { GitHubSyncService } from './github-sync.service';

const fsMocks = {
    writeFileSync: fs.writeFileSync as jest.Mock,
    readFileSync: fs.readFileSync as jest.Mock,
    existsSync: fs.existsSync as jest.Mock,
    mkdirSync: fs.mkdirSync as jest.Mock,
    readdirSync: fs.readdirSync as jest.Mock,
};

/**
 * Pins the `GitHubSyncService` round-trip contract over the per-user
 * `ever-works-config` repo. The service is the public-facing surface for
 * "back up my account into a private GitHub repo and pull from it later".
 *
 * Critical invariants this suite locks:
 *
 *   1. The repo MUST be private — both for `createNew` (created with
 *      `isPrivate:true`) and for `repoFullName` (an existing public repo
 *      throws). A leak here would dump masked-but-sensitive metadata into
 *      a public namespace.
 *   2. Every push/pull failure path MUST update `lastSyncError` on the
 *      sync-config row before re-throwing, so the UI can show *why* the
 *      last sync failed.
 *   3. Pull always forces `payload.includesSecrets = false` regardless of
 *      what's stored in the repo — secrets are *masked* in the export, so
 *      claiming `includesSecrets:true` would let the import flow attempt
 *      to write `MASKED:...` strings as if they were real credentials.
 *      (The import side has a second masked-string detector as defence in
 *      depth, but this is the first gate.)
 *   4. Slug-as-filename traversal is blocked: `path.basename(slug)` is
 *      compared to the original slug, and any mismatch is logged and
 *      skipped. This is the on-write guard against a `../` slug; the
 *      on-read side enforces the same check before recursing into a dir.
 */
describe('GitHubSyncService', () => {
    function makeService() {
        const gitFacade = {
            getUser: jest.fn(),
            repositoryExists: jest.fn(),
            getRepository: jest.fn(),
            createRepository: jest.fn(),
            cloneOrPull: jest.fn().mockResolvedValue('/tmp/clone'),
            addAll: jest.fn().mockResolvedValue(undefined),
            getStatus: jest.fn().mockResolvedValue([]),
            commit: jest.fn().mockResolvedValue(undefined),
            push: jest.fn().mockResolvedValue(undefined),
        };
        const authAccountRepository = {
            findProviderAccount: jest.fn(),
        };
        const userRepository = {
            findById: jest.fn(),
        };
        const syncConfigRepository = {
            findByUser: jest.fn(),
            upsert: jest.fn(),
            delete: jest.fn(),
            updateLastPush: jest.fn(),
            updateLastPull: jest.fn(),
            updateError: jest.fn(),
        };
        const exportService = {
            exportAccountData: jest.fn(),
        };
        const importService = {
            previewImport: jest.fn(),
            applyImport: jest.fn(),
        };

        const service = new GitHubSyncService(
            gitFacade as any,
            authAccountRepository as any,
            userRepository as any,
            syncConfigRepository as any,
            exportService as any,
            importService as any,
        );

        // Reset fs mocks between tests
        for (const m of Object.values(fsMocks)) m.mockReset();

        return {
            service,
            mocks: {
                gitFacade,
                authAccountRepository,
                userRepository,
                syncConfigRepository,
                exportService,
                importService,
            },
        };
    }

    function makePayload(overrides: any = {}) {
        return {
            version: 1,
            exportedAt: '2026-05-08T00:00:00.000Z',
            includesSecrets: false,
            data: {
                profile: { username: 'octo', email: 'o@e.com' },
                works: [],
                userPlugins: [],
            },
            ...overrides,
        };
    }

    describe('getSyncStatus', () => {
        it('returns {configured:false, hasOAuth:false} when no config and no OAuth', async () => {
            const { service, mocks } = makeService();
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue(null);
            mocks.syncConfigRepository.findByUser.mockResolvedValue(null);

            const status = await service.getSyncStatus('user-1');
            expect(status).toEqual({ configured: false, hasOAuth: false });
        });

        it('reports hasOAuth:true when the github auth_accounts row carries an accessToken', async () => {
            const { service, mocks } = makeService();
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue({
                accessToken: 'gho_xxx',
            });
            mocks.syncConfigRepository.findByUser.mockResolvedValue(null);

            const status = await service.getSyncStatus('user-1');
            expect(status.hasOAuth).toBe(true);
        });

        it('reports hasOAuth:false when the github auth_accounts row exists but has no accessToken', async () => {
            const { service, mocks } = makeService();
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue({
                accessToken: '',
            });
            mocks.syncConfigRepository.findByUser.mockResolvedValue(null);

            const status = await service.getSyncStatus('user-1');
            expect(status.hasOAuth).toBe(false);
        });

        it('serialises lastPushAt and lastPullAt as ISO strings when present', async () => {
            const { service, mocks } = makeService();
            const pushAt = new Date('2026-05-01T00:00:00Z');
            const pullAt = new Date('2026-05-02T00:00:00Z');
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue({ accessToken: 'x' });
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'octocat',
                repoName: 'ever-works-config',
                lastPushAt: pushAt,
                lastPullAt: pullAt,
                lastSyncError: null,
            });

            const status = await service.getSyncStatus('user-1');
            expect(status).toEqual({
                configured: true,
                hasOAuth: true,
                repoOwner: 'octocat',
                repoName: 'ever-works-config',
                lastPushAt: pushAt.toISOString(),
                lastPullAt: pullAt.toISOString(),
                lastSyncError: undefined,
            });
        });

        it('omits invalid Date values (NaN getTime) — defends against legacy nullable timestamps', async () => {
            const { service, mocks } = makeService();
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue({ accessToken: 'x' });
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'octocat',
                repoName: 'ever-works-config',
                lastPushAt: new Date('not-a-date'),
                lastPullAt: undefined,
                lastSyncError: 'boom',
            });

            const status = await service.getSyncStatus('user-1');
            expect(status.lastPushAt).toBeUndefined();
            expect(status.lastPullAt).toBeUndefined();
            expect(status.lastSyncError).toBe('boom');
        });
    });

    describe('configureSyncRepo — createNew branch', () => {
        it('creates a private repo when the gh user has none with that name yet', async () => {
            const { service, mocks } = makeService();
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue({ accessToken: 'x' });
            mocks.gitFacade.getUser.mockResolvedValue({ login: 'octocat' });
            mocks.gitFacade.repositoryExists.mockResolvedValue(false);
            mocks.syncConfigRepository.upsert.mockResolvedValue({});
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'octocat',
                repoName: 'ever-works-config',
                lastPushAt: undefined,
                lastPullAt: undefined,
                lastSyncError: null,
            });

            await service.configureSyncRepo('user-1', { createNew: true });

            expect(mocks.gitFacade.createRepository).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: 'ever-works-config',
                    isPrivate: true,
                }),
                expect.objectContaining({ providerId: 'github', userId: 'user-1' }),
            );
            expect(mocks.syncConfigRepository.upsert).toHaveBeenCalledWith('user-1', {
                provider: 'github',
                repoOwner: 'octocat',
                repoName: 'ever-works-config',
            });
        });

        it('skips create when an `ever-works-config` repo already exists AND it is private', async () => {
            const { service, mocks } = makeService();
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue({ accessToken: 'x' });
            mocks.gitFacade.getUser.mockResolvedValue({ login: 'octocat' });
            mocks.gitFacade.repositoryExists.mockResolvedValue(true);
            mocks.gitFacade.getRepository.mockResolvedValue({ isPrivate: true });
            mocks.syncConfigRepository.upsert.mockResolvedValue({});
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'octocat',
                repoName: 'ever-works-config',
            });

            await service.configureSyncRepo('user-1', { createNew: true });

            expect(mocks.gitFacade.createRepository).not.toHaveBeenCalled();
            expect(mocks.syncConfigRepository.upsert).toHaveBeenCalled();
        });

        it('REJECTS reuse of an existing PUBLIC `ever-works-config` repo', async () => {
            const { service, mocks } = makeService();
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue({ accessToken: 'x' });
            mocks.gitFacade.getUser.mockResolvedValue({ login: 'octocat' });
            mocks.gitFacade.repositoryExists.mockResolvedValue(true);
            mocks.gitFacade.getRepository.mockResolvedValue({ isPrivate: false });

            await expect(service.configureSyncRepo('user-1', { createNew: true })).rejects.toThrow(
                /Repository must be private/,
            );
            expect(mocks.gitFacade.createRepository).not.toHaveBeenCalled();
            expect(mocks.syncConfigRepository.upsert).not.toHaveBeenCalled();
        });

        it('refuses to start without GitHub OAuth (ensureGitHubOAuth gate)', async () => {
            const { service, mocks } = makeService();
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue(null);

            await expect(service.configureSyncRepo('user-1', { createNew: true })).rejects.toThrow(
                /GitHub OAuth not connected/,
            );
            expect(mocks.gitFacade.getUser).not.toHaveBeenCalled();
        });
    });

    describe('configureSyncRepo — repoFullName branch', () => {
        it('rejects malformed repoFullName (must be exactly owner/repo)', async () => {
            const { service, mocks } = makeService();
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue({ accessToken: 'x' });

            await expect(
                service.configureSyncRepo('user-1', { repoFullName: 'malformed' }),
            ).rejects.toThrow(/Invalid repository name/);

            await expect(
                service.configureSyncRepo('user-1', { repoFullName: 'a/b/c' }),
            ).rejects.toThrow(/Invalid repository name/);
        });

        it('rejects when the repo cannot be reached', async () => {
            const { service, mocks } = makeService();
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue({ accessToken: 'x' });
            mocks.gitFacade.getRepository.mockResolvedValue(null);

            await expect(
                service.configureSyncRepo('user-1', { repoFullName: 'me/not-here' }),
            ).rejects.toThrow(/not found or inaccessible/);
        });

        it('rejects a public repo as a sync target (no public-repo backups, ever)', async () => {
            const { service, mocks } = makeService();
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue({ accessToken: 'x' });
            mocks.gitFacade.getRepository.mockResolvedValue({ isPrivate: false });

            await expect(
                service.configureSyncRepo('user-1', { repoFullName: 'me/public-repo' }),
            ).rejects.toThrow(/Syncing to public repositories is not allowed/);
        });

        it('persists the chosen owner/repo when the repo is private', async () => {
            const { service, mocks } = makeService();
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue({ accessToken: 'x' });
            mocks.gitFacade.getRepository.mockResolvedValue({ isPrivate: true });
            mocks.syncConfigRepository.upsert.mockResolvedValue({});
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'private-cfg',
            });

            await service.configureSyncRepo('user-1', { repoFullName: 'me/private-cfg' });

            expect(mocks.syncConfigRepository.upsert).toHaveBeenCalledWith('user-1', {
                provider: 'github',
                repoOwner: 'me',
                repoName: 'private-cfg',
            });
        });
    });

    describe('configureSyncRepo — neither createNew nor repoFullName', () => {
        it('throws when both flags are missing', async () => {
            const { service, mocks } = makeService();
            mocks.authAccountRepository.findProviderAccount.mockResolvedValue({ accessToken: 'x' });

            await expect(service.configureSyncRepo('user-1', {})).rejects.toThrow(
                /Either createNew or repoFullName must be provided/,
            );
        });
    });

    describe('pushToGitHub', () => {
        it('throws when no sync-config row exists', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue(null);

            await expect(service.pushToGitHub('user-1')).rejects.toThrow(/Sync not configured/);
        });

        it('honours the per-config includeSecrets default and forwards options.includeSecrets if set', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
                includeSecrets: true,
            });
            mocks.exportService.exportAccountData.mockResolvedValue(makePayload());
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            mocks.gitFacade.cloneOrPull.mockResolvedValue('/tmp/clone');
            mocks.gitFacade.getStatus.mockResolvedValue([]); // no commits

            await service.pushToGitHub('user-1');

            // Review-fix C3 (second-pass NEW-3): pushToGitHub now also
            // forwards the v2-tail toggles. Use objectContaining so the
            // assertion focuses on `includeSecrets` (the original intent
            // of this spec) without coupling to the v2 defaults.
            expect(mocks.exportService.exportAccountData).toHaveBeenCalledWith(
                'user-1',
                expect.objectContaining({ includeSecrets: true }),
            );
        });

        it('writes manifest.json + profile.json + plugins/user-plugins.json + per-work files', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
                includeSecrets: false,
            });
            mocks.exportService.exportAccountData.mockResolvedValue(
                makePayload({
                    data: {
                        profile: { username: 'octo', email: 'o@e.com' },
                        works: [
                            {
                                slug: 'a',
                                name: 'A',
                                members: [{ userId: 'm1', role: 'editor' }],
                                customDomains: [],
                                workPlugins: [],
                                items: [{ name: 'i1' }],
                                comparisons: [{ slug: 'cmp', id: 'c1' }],
                                siteConfig: { x: 1 },
                                markdownTemplate: { header: 'H', footer: 'F' },
                                advancedPrompts: { itemGeneration: 'foo' },
                                schedule: { cadence: 'daily', status: 'active' },
                                categories: [{ id: 'c1', name: 'C' }],
                                tags: [{ id: 't1', name: 'T' }],
                                collections: [{ id: 'col1', name: 'Col' }],
                            },
                        ],
                        userPlugins: [{ pluginId: 'p1' }],
                    },
                }),
            );
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            mocks.gitFacade.getStatus.mockResolvedValue([{ file: 'manifest.json' }]); // commit needed

            await service.pushToGitHub('user-1');

            const writtenPaths = fsMocks.writeFileSync.mock.calls.map((c) => c[0]);
            expect(writtenPaths).toEqual(
                expect.arrayContaining([
                    expect.stringMatching(/manifest\.json$/),
                    expect.stringMatching(/profile\.json$/),
                    expect.stringMatching(/plugins[\\/]user-plugins\.json$/),
                    expect.stringMatching(/works[\\/]a[\\/]config\.json$/),
                    expect.stringMatching(/works[\\/]a[\\/]members\.json$/),
                    expect.stringMatching(/works[\\/]a[\\/]domains\.json$/),
                    expect.stringMatching(/works[\\/]a[\\/]plugins\.json$/),
                    expect.stringMatching(/works[\\/]a[\\/]prompts\.json$/),
                    expect.stringMatching(/works[\\/]a[\\/]schedule\.json$/),
                    expect.stringMatching(/works[\\/]a[\\/]site-config\.json$/),
                    expect.stringMatching(/works[\\/]a[\\/]markdown-template\.json$/),
                    expect.stringMatching(/works[\\/]a[\\/]items\.json$/),
                    expect.stringMatching(/works[\\/]a[\\/]categories\.json$/),
                    expect.stringMatching(/works[\\/]a[\\/]tags\.json$/),
                    expect.stringMatching(/works[\\/]a[\\/]collections\.json$/),
                    expect.stringMatching(/works[\\/]a[\\/]comparisons\.json$/),
                ]),
            );
        });

        it('blocks works with traversal-shaped slugs (path.basename mismatch → skip + warning, not write)', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
                includeSecrets: false,
            });
            mocks.exportService.exportAccountData.mockResolvedValue(
                makePayload({
                    data: {
                        profile: { username: 'octo', email: 'o@e.com' },
                        works: [
                            {
                                slug: '../escape',
                                name: 'X',
                                members: [],
                                customDomains: [],
                                workPlugins: [],
                            },
                        ],
                        userPlugins: [],
                    },
                }),
            );
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            mocks.gitFacade.getStatus.mockResolvedValue([]);

            await service.pushToGitHub('user-1');

            const writtenPaths = fsMocks.writeFileSync.mock.calls.map((c) => c[0]);
            expect(writtenPaths.some((p: string) => p.includes('escape'))).toBe(false);
            expect(writtenPaths.some((p: string) => p.includes('config.json'))).toBe(false);
        });

        it('skips commit + push when getStatus returns []', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
                includeSecrets: false,
            });
            mocks.exportService.exportAccountData.mockResolvedValue(makePayload());
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            mocks.gitFacade.getStatus.mockResolvedValue([]);

            await service.pushToGitHub('user-1');

            expect(mocks.gitFacade.commit).not.toHaveBeenCalled();
            expect(mocks.gitFacade.push).not.toHaveBeenCalled();
            expect(mocks.syncConfigRepository.updateLastPush).not.toHaveBeenCalled();
        });

        it('commits + pushes + updates lastPushAt when status non-empty', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
                includeSecrets: false,
            });
            mocks.exportService.exportAccountData.mockResolvedValue(makePayload());
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            mocks.gitFacade.getStatus.mockResolvedValue([{ file: 'manifest.json' }]);

            await service.pushToGitHub('user-1');

            expect(mocks.gitFacade.commit).toHaveBeenCalled();
            expect(mocks.gitFacade.push).toHaveBeenCalled();
            expect(mocks.syncConfigRepository.updateLastPush).toHaveBeenCalledWith('user-1');
        });

        it('records lastSyncError and rethrows when the export fails', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
                includeSecrets: false,
            });
            mocks.exportService.exportAccountData.mockRejectedValue(new Error('export-fail'));

            await expect(service.pushToGitHub('user-1')).rejects.toThrow('export-fail');
            expect(mocks.syncConfigRepository.updateError).toHaveBeenCalledWith(
                'user-1',
                'export-fail',
            );
        });

        it('coerces non-Error rejections to String(error) when recording lastSyncError', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
                includeSecrets: false,
            });
            mocks.exportService.exportAccountData.mockRejectedValue('plain-string');

            await expect(service.pushToGitHub('user-1')).rejects.toBe('plain-string');
            expect(mocks.syncConfigRepository.updateError).toHaveBeenCalledWith(
                'user-1',
                'plain-string',
            );
        });
    });

    describe('pullFromGitHub', () => {
        it('throws when no sync-config row exists', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue(null);

            await expect(service.pullFromGitHub('user-1')).rejects.toThrow(/Sync not configured/);
        });

        it('returns a "no valid configuration" preview when manifest.json is missing in the cloned repo', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
            });
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            // existsSync returns false for manifest.json
            fsMocks.existsSync.mockReturnValue(false);

            const preview = await service.pullFromGitHub('user-1');
            expect(preview.valid).toBe(false);
            expect(preview.errors).toEqual(['No valid configuration found in repository']);
            // No previewImport call when no manifest
            expect(mocks.importService.previewImport).not.toHaveBeenCalled();
        });

        it('forces payload.includesSecrets = false on the preview path (defence in depth)', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
            });
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            // Manifest exists and the readFileSync returns includesSecrets:true
            fsMocks.existsSync.mockImplementation((p: string) => p.endsWith('manifest.json'));
            fsMocks.readFileSync.mockImplementation((p: string) => {
                if (p.endsWith('manifest.json'))
                    return JSON.stringify({ version: 1, syncedAt: 'x', includesSecrets: true });
                if (p.endsWith('profile.json'))
                    return JSON.stringify({ username: 'a', email: 'a@a' });
                return '{}';
            });
            fsMocks.readdirSync.mockReturnValue([]);
            mocks.importService.previewImport.mockResolvedValue({ valid: true });

            await service.pullFromGitHub('user-1');

            const callArg = mocks.importService.previewImport.mock.calls[0][1];
            expect(callArg.includesSecrets).toBe(false); // FORCED to false
        });

        it('records lastSyncError when cloning fails', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
            });
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            mocks.gitFacade.cloneOrPull.mockRejectedValue(new Error('clone-fail'));

            await expect(service.pullFromGitHub('user-1')).rejects.toThrow('clone-fail');
            expect(mocks.syncConfigRepository.updateError).toHaveBeenCalledWith(
                'user-1',
                'clone-fail',
            );
        });
    });

    describe('applyPull', () => {
        it('throws when no config row exists', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue(null);

            await expect(service.applyPull('user-1', [])).rejects.toThrow(/Sync not configured/);
        });

        it('returns a no-op result when the cloned repo lacks a manifest', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
            });
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            fsMocks.existsSync.mockReturnValue(false);

            const result = await service.applyPull('user-1', []);
            expect(result.success).toBe(false);
            expect(result.errors).toEqual(['No valid configuration found in repository']);
            expect(mocks.importService.applyImport).not.toHaveBeenCalled();
        });

        it('updates lastPullAt only when applyImport returns success:true', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
            });
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            fsMocks.existsSync.mockImplementation((p: string) => p.endsWith('manifest.json'));
            fsMocks.readFileSync.mockImplementation((p: string) => {
                if (p.endsWith('manifest.json'))
                    return JSON.stringify({ version: 1, syncedAt: 'x', includesSecrets: false });
                if (p.endsWith('profile.json'))
                    return JSON.stringify({ username: 'a', email: 'a@a' });
                return '{}';
            });
            fsMocks.readdirSync.mockReturnValue([]);
            mocks.importService.applyImport.mockResolvedValue({ success: true });

            await service.applyPull('user-1', []);

            expect(mocks.syncConfigRepository.updateLastPull).toHaveBeenCalledWith('user-1');
        });

        it('does NOT update lastPullAt when applyImport returns success:false', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
            });
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            fsMocks.existsSync.mockImplementation((p: string) => p.endsWith('manifest.json'));
            fsMocks.readFileSync.mockImplementation((p: string) => {
                if (p.endsWith('manifest.json'))
                    return JSON.stringify({ version: 1, syncedAt: 'x', includesSecrets: false });
                if (p.endsWith('profile.json'))
                    return JSON.stringify({ username: 'a', email: 'a@a' });
                return '{}';
            });
            fsMocks.readdirSync.mockReturnValue([]);
            mocks.importService.applyImport.mockResolvedValue({
                success: false,
                worksCreated: 0,
                worksUpdated: 0,
                worksSkipped: 0,
                userPluginsImported: 0,
                errors: ['boom'],
                warnings: [],
            });

            await service.applyPull('user-1', []);

            expect(mocks.syncConfigRepository.updateLastPull).not.toHaveBeenCalled();
        });

        it('forces payload.includesSecrets = false before forwarding to applyImport', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
            });
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            fsMocks.existsSync.mockImplementation((p: string) => p.endsWith('manifest.json'));
            fsMocks.readFileSync.mockImplementation((p: string) => {
                if (p.endsWith('manifest.json'))
                    return JSON.stringify({ version: 1, syncedAt: 'x', includesSecrets: true });
                if (p.endsWith('profile.json'))
                    return JSON.stringify({ username: 'a', email: 'a@a' });
                return '{}';
            });
            fsMocks.readdirSync.mockReturnValue([]);
            mocks.importService.applyImport.mockResolvedValue({ success: true });

            await service.applyPull('user-1', []);

            const callArg = mocks.importService.applyImport.mock.calls[0][1];
            expect(callArg.includesSecrets).toBe(false); // FORCED
        });

        it('records lastSyncError when cloneOrPull rejects', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
            });
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            mocks.gitFacade.cloneOrPull.mockRejectedValue(new Error('boom'));

            await expect(service.applyPull('user-1', [])).rejects.toThrow('boom');
            expect(mocks.syncConfigRepository.updateError).toHaveBeenCalledWith('user-1', 'boom');
        });
    });

    describe('removeSyncConfig', () => {
        it('delegates to syncConfigRepository.delete(userId)', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.delete.mockResolvedValue(true);

            await service.removeSyncConfig('user-1');

            expect(mocks.syncConfigRepository.delete).toHaveBeenCalledWith('user-1');
        });
    });

    describe('readExportFiles — defensive parsing path', () => {
        it('returns null when JSON parsing throws (graceful corrupted-repo recovery)', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
            });
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            // Manifest exists but parse throws
            fsMocks.existsSync.mockImplementation((p: string) => p.endsWith('manifest.json'));
            fsMocks.readFileSync.mockReturnValue('{not valid json');

            const preview = await service.pullFromGitHub('user-1');
            expect(preview.valid).toBe(false);
            expect(preview.errors).toEqual(['No valid configuration found in repository']);
        });

        it('aggregates a multi-work repo (recursing into works/<slug> dirs)', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
            });
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            // Manifest path always exists; works dir exists; per-file existsSync only true for the keys we care about.
            fsMocks.existsSync.mockImplementation((p: string) => {
                // root manifest + worksDir + per-file existsSync inside works subdir
                return (
                    p.endsWith('manifest.json') ||
                    p.endsWith('works') ||
                    p.endsWith('config.json') ||
                    p.endsWith('items.json') ||
                    p.endsWith('profile.json') ||
                    p.endsWith('user-plugins.json')
                );
            });
            fsMocks.readdirSync.mockReturnValue([
                { name: 'a', isDirectory: () => true },
                { name: '../escape', isDirectory: () => true }, // basename mismatch → filtered
                { name: 'b', isDirectory: () => false }, // not a directory → filtered
            ] as any);
            fsMocks.readFileSync.mockImplementation((p: string) => {
                if (p.endsWith('manifest.json'))
                    return JSON.stringify({ version: 1, syncedAt: 'x', includesSecrets: false });
                if (p.endsWith('profile.json'))
                    return JSON.stringify({ username: 'a', email: 'a@a' });
                if (p.endsWith('user-plugins.json')) return JSON.stringify([{ pluginId: 'p1' }]);
                if (p.endsWith('config.json')) return JSON.stringify({ name: 'A' });
                if (p.endsWith('items.json')) return JSON.stringify([{ name: 'i1' }]);
                return '{}';
            });
            mocks.importService.previewImport.mockResolvedValue({ valid: true });

            await service.pullFromGitHub('user-1');

            const payload = mocks.importService.previewImport.mock.calls[0][1];
            expect(payload.data.works).toHaveLength(1); // ..nope filtered out by safeName check
            expect(payload.data.works[0].slug).toBe('a');
            expect(payload.data.works[0].items).toEqual([{ name: 'i1' }]);
            expect(payload.data.userPlugins).toEqual([{ pluginId: 'p1' }]);
        });
    });

    /**
     * Phase 19.5 — Agents/Skills/Tasks v2 tail subdir layout.
     *
     * The v2 payload tail (`data.agents` / `data.skills` / `data.tasks`)
     * writes one json file per row under top-level `agents/` /
     * `skills/` / `tasks/` subdirs. One file per row keeps git diffs
     * clean — an Agent SOUL.md edit is a single-file diff instead of
     * a json-blob rewrite. The manifest carries the per-section counts
     * + `version:2` so a pull-side reader can short-circuit when a
     * section is empty.
     */
    describe('v2 tail subdir layout (Phase 19.5)', () => {
        function makeV2Payload(over: any = {}) {
            return {
                version: 2,
                exportedAt: '2026-05-08T00:00:00.000Z',
                includesSecrets: false,
                data: {
                    profile: { username: 'octo', email: 'o@e.com' },
                    works: [],
                    userPlugins: [],
                    agents: [],
                    skills: [],
                    tasks: [],
                    ...over.data,
                },
            };
        }

        it('writes one json file per Agent under agents/ keyed by identity.slug', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
                includeSecrets: false,
            });
            mocks.exportService.exportAccountData.mockResolvedValue(
                makeV2Payload({
                    data: {
                        agents: [
                            { __kind: 'agent', identity: { slug: 'ceo', name: 'CEO' } },
                            { __kind: 'agent', identity: { slug: 'devops', name: 'DevOps' } },
                        ],
                    },
                }),
            );
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            mocks.gitFacade.getStatus.mockResolvedValue([{ file: 'agents/ceo.json' }]);

            await service.pushToGitHub('user-1');

            const writtenPaths = fsMocks.writeFileSync.mock.calls.map((c) => c[0]);
            expect(writtenPaths).toEqual(
                expect.arrayContaining([
                    expect.stringMatching(/agents[\\/]ceo\.json$/),
                    expect.stringMatching(/agents[\\/]devops\.json$/),
                ]),
            );
        });

        it('manifest carries v2 counts when the tail has rows', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
                includeSecrets: false,
            });
            mocks.exportService.exportAccountData.mockResolvedValue(
                makeV2Payload({
                    data: {
                        agents: [{ __kind: 'agent', identity: { slug: 'ceo' } }],
                        skills: [{ __kind: 'skill', slug: 'cron-defaults' }],
                        tasks: [
                            { __kind: 'task', slug: 'T-1' },
                            { __kind: 'task', slug: 'T-2' },
                        ],
                    },
                }),
            );
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            mocks.gitFacade.getStatus.mockResolvedValue([{ file: 'manifest.json' }]);

            await service.pushToGitHub('user-1');

            const manifestCall = fsMocks.writeFileSync.mock.calls.find((c) =>
                /manifest\.json$/.test(c[0] as string),
            );
            expect(manifestCall).toBeDefined();
            const manifest = JSON.parse(manifestCall![1] as string);
            expect(manifest.version).toBe(2);
            expect(manifest.agentCount).toBe(1);
            expect(manifest.skillCount).toBe(1);
            expect(manifest.taskCount).toBe(2);
        });

        it('skips agents/skills/tasks subdir entirely when the array is empty (v1-compatible)', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
                includeSecrets: false,
            });
            mocks.exportService.exportAccountData.mockResolvedValue(makePayload()); // v1, no tail
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            mocks.gitFacade.getStatus.mockResolvedValue([{ file: 'manifest.json' }]);

            await service.pushToGitHub('user-1');

            const writtenPaths = fsMocks.writeFileSync.mock.calls.map((c) => c[0] as string);
            expect(writtenPaths.find((p) => /agents[\\/]/.test(p))).toBeUndefined();
            expect(writtenPaths.find((p) => /skills[\\/]/.test(p))).toBeUndefined();
            expect(writtenPaths.find((p) => /^[^.]*tasks[\\/]/.test(p))).toBeUndefined();
        });

        it('blocks v2-tail rows with traversal-shaped slugs (path.basename mismatch → skip)', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
                includeSecrets: false,
            });
            mocks.exportService.exportAccountData.mockResolvedValue(
                makeV2Payload({
                    data: {
                        agents: [{ __kind: 'agent', identity: { slug: '../escape' } }],
                        skills: [{ __kind: 'skill', slug: '../sneaky' }],
                        tasks: [{ __kind: 'task', slug: '../also-bad' }],
                    },
                }),
            );
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });
            mocks.gitFacade.getStatus.mockResolvedValue([]);

            await service.pushToGitHub('user-1');

            const writtenPaths = fsMocks.writeFileSync.mock.calls.map((c) => c[0] as string);
            expect(writtenPaths.find((p) => /escape\.json$/.test(p))).toBeUndefined();
            expect(writtenPaths.find((p) => /sneaky\.json$/.test(p))).toBeUndefined();
            expect(writtenPaths.find((p) => /also-bad\.json$/.test(p))).toBeUndefined();
        });

        it('readExportFiles walks agents/ + skills/ + tasks/ subdirs and surfaces v2 tail', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
                includeSecrets: false,
            });
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });

            // Manifest signals v2 + counts.
            const fileTree: Record<string, any> = {
                '/tmp/clone/manifest.json': {
                    version: 2,
                    syncedAt: '2026-05-08T00:00:00.000Z',
                    includesSecrets: false,
                    agentCount: 1,
                    skillCount: 1,
                    taskCount: 1,
                },
                '/tmp/clone/profile.json': { username: 'octo', email: 'o@e.com' },
                '/tmp/clone/plugins/user-plugins.json': [],
                '/tmp/clone/agents/ceo.json': { __kind: 'agent', identity: { slug: 'ceo' } },
                '/tmp/clone/skills/cron.json': { __kind: 'skill', slug: 'cron' },
                '/tmp/clone/tasks/T-1.json': { __kind: 'task', slug: 'T-1' },
            };
            fsMocks.existsSync.mockImplementation((p: any) => p in fileTree || p === '/tmp/clone/agents' || p === '/tmp/clone/skills' || p === '/tmp/clone/tasks' || p === '/tmp/clone/works');
            fsMocks.readFileSync.mockImplementation((p: any) =>
                p in fileTree ? JSON.stringify(fileTree[p]) : '',
            );
            fsMocks.readdirSync.mockImplementation((p: any, opts: any) => {
                const withTypes = opts && opts.withFileTypes;
                const entries =
                    p === '/tmp/clone/agents'
                        ? [{ name: 'ceo.json', isFile: () => true, isDirectory: () => false }]
                        : p === '/tmp/clone/skills'
                          ? [{ name: 'cron.json', isFile: () => true, isDirectory: () => false }]
                          : p === '/tmp/clone/tasks'
                            ? [{ name: 'T-1.json', isFile: () => true, isDirectory: () => false }]
                            : p === '/tmp/clone/works'
                              ? []
                              : [];
                return withTypes ? entries : entries.map((e: any) => e.name);
            });
            mocks.importService.previewImport.mockResolvedValue({});

            await service.pullFromGitHub('user-1');

            const payload = mocks.importService.previewImport.mock.calls[0][1];
            expect(payload.version).toBe(2);
            expect(payload.data.agents).toEqual([{ __kind: 'agent', identity: { slug: 'ceo' } }]);
            expect(payload.data.skills).toEqual([{ __kind: 'skill', slug: 'cron' }]);
            expect(payload.data.tasks).toEqual([{ __kind: 'task', slug: 'T-1' }]);
        });

        it('readExportFiles infers v2 from presence of tail subdirs when manifest still says version=1', async () => {
            const { service, mocks } = makeService();
            mocks.syncConfigRepository.findByUser.mockResolvedValue({
                repoOwner: 'me',
                repoName: 'cfg',
                includeSecrets: false,
            });
            mocks.userRepository.findById.mockResolvedValue({ username: 'octo', email: 'o@e.com' });

            const fileTree: Record<string, any> = {
                '/tmp/clone/manifest.json': {
                    version: 1, // stale — but tail subdirs exist
                    syncedAt: '2026-05-08T00:00:00.000Z',
                    includesSecrets: false,
                },
                '/tmp/clone/profile.json': { username: 'octo', email: 'o@e.com' },
                '/tmp/clone/plugins/user-plugins.json': [],
                '/tmp/clone/agents/ceo.json': { __kind: 'agent', identity: { slug: 'ceo' } },
            };
            fsMocks.existsSync.mockImplementation((p: any) => p in fileTree || p === '/tmp/clone/agents');
            fsMocks.readFileSync.mockImplementation((p: any) =>
                p in fileTree ? JSON.stringify(fileTree[p]) : '',
            );
            fsMocks.readdirSync.mockImplementation((p: any, opts: any) => {
                const withTypes = opts && opts.withFileTypes;
                const entries =
                    p === '/tmp/clone/agents'
                        ? [{ name: 'ceo.json', isFile: () => true, isDirectory: () => false }]
                        : [];
                return withTypes ? entries : entries.map((e: any) => e.name);
            });
            mocks.importService.previewImport.mockResolvedValue({});

            await service.pullFromGitHub('user-1');

            const payload = mocks.importService.previewImport.mock.calls[0][1];
            expect(payload.version).toBe(2); // inferred from tail presence
            expect(payload.data.agents).toHaveLength(1);
        });
    });
});
