import { RepositoryManagementService } from '../repository-management.service';
import type { Work, RepoVisibility } from '@src/entities/work.entity';
import type { User } from '@src/entities/user.entity';

describe('RepositoryManagementService', () => {
    let gitFacade: {
        getRepository: jest.Mock;
        updateRepository: jest.Mock;
    };
    let workRepository: { update: jest.Mock };
    let service: RepositoryManagementService;

    beforeEach(() => {
        gitFacade = {
            getRepository: jest.fn(),
            updateRepository: jest.fn(),
        };
        workRepository = { update: jest.fn().mockResolvedValue(undefined) };
        service = new RepositoryManagementService(
            gitFacade as any,
            workRepository as any,
        );
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    const buildWork = (overrides: Partial<Work> = {}): Work => {
        const work = {
            id: 'work-1',
            gitProvider: 'github',
            repoVisibility: undefined,
            getDataRepo: jest.fn().mockReturnValue('data-repo'),
            getMainRepo: jest.fn().mockReturnValue('main-repo'),
            getWebsiteRepo: jest.fn().mockReturnValue('website-repo'),
            getRepoOwner: jest.fn().mockImplementation((type: string) => {
                // Pinned: the source's getRepoOwner accepts the
                // repository role ('data'/'work'/'website') and may
                // return a different owner per role (organisations
                // separate website repos from data repos). The mock
                // distinguishes by role so a future swap to a
                // hard-coded role argument breaks loudly.
                return type === 'website' ? 'website-owner' : 'data-owner';
            }),
            ...overrides,
        };
        return work as unknown as Work;
    };

    const buildUser = (overrides: Partial<User> = {}): User =>
        ({ id: 'user-1', ...overrides }) as User;

    describe('getRepositoriesStatus', () => {
        it('queries gitFacade.getRepository for all THREE repository roles in parallel', async () => {
            // Pinned: the source uses Promise.all over a hard-coded
            // [data, work, website] array. A future addition (e.g.
            // a 4th repo role) MUST be a deliberate change and will
            // break this assertion.
            const work = buildWork();
            const user = buildUser();
            gitFacade.getRepository.mockResolvedValue({
                url: 'https://github.com/owner/repo',
                isPrivate: false,
            });

            await service.getRepositoriesStatus(work, user);

            expect(gitFacade.getRepository).toHaveBeenCalledTimes(3);
            expect(work.getDataRepo).toHaveBeenCalledTimes(1);
            expect(work.getMainRepo).toHaveBeenCalledTimes(1);
            expect(work.getWebsiteRepo).toHaveBeenCalledTimes(1);
            // getRepoOwner called once per repo role (3 times total)
            expect((work.getRepoOwner as jest.Mock).mock.calls).toEqual([
                ['data'],
                ['work'],
                ['website'],
            ]);
        });

        it('forwards the documented context envelope (userId, providerId, workId) to gitFacade.getRepository', async () => {
            const work = buildWork({ id: 'work-ctx', gitProvider: 'gitlab' as any });
            const user = buildUser({ id: 'user-ctx' });
            gitFacade.getRepository.mockResolvedValue({
                url: 'https://example.test/x',
                isPrivate: false,
            });

            await service.getRepositoriesStatus(work, user);

            const dataCall = gitFacade.getRepository.mock.calls[0];
            expect(dataCall[0]).toBe('data-owner');
            expect(dataCall[1]).toBe('data-repo');
            expect(dataCall[2]).toEqual({
                userId: 'user-ctx',
                providerId: 'gitlab',
                workId: 'work-ctx',
            });
        });

        it('maps an existing repo to the populated status shape', async () => {
            const work = buildWork();
            const user = buildUser();
            gitFacade.getRepository.mockResolvedValueOnce({
                url: 'https://github.com/data-owner/data-repo',
                isPrivate: true,
            });
            gitFacade.getRepository.mockResolvedValueOnce({
                url: 'https://github.com/data-owner/main-repo',
                isPrivate: false,
            });
            gitFacade.getRepository.mockResolvedValueOnce({
                url: 'https://github.com/website-owner/website-repo',
                isPrivate: true,
            });

            const result = await service.getRepositoriesStatus(work, user);

            expect(result).toEqual([
                {
                    type: 'data',
                    name: 'data-repo',
                    url: 'https://github.com/data-owner/data-repo',
                    isPrivate: true,
                    exists: true,
                },
                {
                    type: 'work',
                    name: 'main-repo',
                    url: 'https://github.com/data-owner/main-repo',
                    isPrivate: false,
                    exists: true,
                },
                {
                    type: 'website',
                    name: 'website-repo',
                    url: 'https://github.com/website-owner/website-repo',
                    isPrivate: true,
                    exists: true,
                },
            ]);
        });

        it('treats a null/undefined gitFacade response as exists=false with safe-default privacy', async () => {
            // Pinned: when the upstream API returns null (legacy code paths
            // and some providers) we MUST still return a fully-populated
            // entry so the UI can render an "Initialise repository" button.
            // The default `isPrivate: true` is the safe assumption — we
            // never want to mis-report a private-by-default repo as public.
            const work = buildWork();
            const user = buildUser();
            gitFacade.getRepository.mockResolvedValue(null);

            const result = await service.getRepositoriesStatus(work, user);

            expect(result).toEqual([
                { type: 'data', name: 'data-repo', url: '', isPrivate: true, exists: false },
                { type: 'work', name: 'main-repo', url: '', isPrivate: true, exists: false },
                {
                    type: 'website',
                    name: 'website-repo',
                    url: '',
                    isPrivate: true,
                    exists: false,
                },
            ]);
        });

        it('treats a thrown gitFacade rejection as exists=false (silently swallows the error)', async () => {
            // Pinned: 404s from the git provider must NOT fail the whole
            // status lookup — they are the expected "repo not yet
            // initialised" signal. A future tightening to rethrow on
            // non-404 errors would be a deliberate change and would
            // require this test to evolve.
            const work = buildWork();
            const user = buildUser();
            gitFacade.getRepository.mockRejectedValue(new Error('404 not found'));

            const result = await service.getRepositoriesStatus(work, user);

            expect(result.every((r) => !r.exists)).toBe(true);
            expect(result.every((r) => r.url === '')).toBe(true);
            expect(result.every((r) => r.isPrivate === true)).toBe(true);
        });

        it('handles a partial-existence mix (data exists, others fail) without mis-aligning entries', async () => {
            const work = buildWork();
            const user = buildUser();
            gitFacade.getRepository.mockResolvedValueOnce({
                url: 'https://github.com/data-owner/data-repo',
                isPrivate: false,
            });
            gitFacade.getRepository.mockRejectedValueOnce(new Error('404'));
            gitFacade.getRepository.mockResolvedValueOnce(null);

            const result = await service.getRepositoriesStatus(work, user);

            expect(result[0]).toEqual({
                type: 'data',
                name: 'data-repo',
                url: 'https://github.com/data-owner/data-repo',
                isPrivate: false,
                exists: true,
            });
            expect(result[1].exists).toBe(false);
            expect(result[1].type).toBe('work');
            expect(result[2].exists).toBe(false);
            expect(result[2].type).toBe('website');
        });

        it('persists the freshly-computed visibility cache when work has no prior visibility', async () => {
            // Pinned: a missing `repoVisibility` on the work entity is
            // the "never queried" state — the first status call MUST
            // seed the cache so subsequent gates can short-circuit on it.
            const work = buildWork({ repoVisibility: undefined });
            const user = buildUser();
            gitFacade.getRepository
                .mockResolvedValueOnce({ url: 'a', isPrivate: false })
                .mockResolvedValueOnce({ url: 'b', isPrivate: true })
                .mockResolvedValueOnce({ url: 'c', isPrivate: false });

            await service.getRepositoriesStatus(work, user);

            expect(workRepository.update).toHaveBeenCalledWith('work-1', {
                repoVisibility: { data: false, work: true, website: false },
            });
        });

        it('SKIPS the cache write when the freshly-computed visibility matches the cached value', async () => {
            // Pinned: this is a write-amplification guard — the most
            // common case is "nothing changed" and we should NOT issue
            // a write. The triple-equals comparison on each role is
            // pinned because a future swap to deep-equal would change
            // the surface (an extra unrelated change would force a write).
            const cached: RepoVisibility = { data: false, work: true, website: false };
            const work = buildWork({ repoVisibility: cached });
            const user = buildUser();
            gitFacade.getRepository
                .mockResolvedValueOnce({ url: 'a', isPrivate: false })
                .mockResolvedValueOnce({ url: 'b', isPrivate: true })
                .mockResolvedValueOnce({ url: 'c', isPrivate: false });

            await service.getRepositoriesStatus(work, user);

            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('writes the cache when ONLY the data flag changed', async () => {
            const cached: RepoVisibility = { data: false, work: true, website: false };
            const work = buildWork({ repoVisibility: cached });
            const user = buildUser();
            gitFacade.getRepository
                .mockResolvedValueOnce({ url: 'a', isPrivate: true })
                .mockResolvedValueOnce({ url: 'b', isPrivate: true })
                .mockResolvedValueOnce({ url: 'c', isPrivate: false });

            await service.getRepositoriesStatus(work, user);

            expect(workRepository.update).toHaveBeenCalledWith('work-1', {
                repoVisibility: { data: true, work: true, website: false },
            });
        });

        it('writes the cache when ONLY the work flag changed', async () => {
            const cached: RepoVisibility = { data: false, work: true, website: false };
            const work = buildWork({ repoVisibility: cached });
            const user = buildUser();
            gitFacade.getRepository
                .mockResolvedValueOnce({ url: 'a', isPrivate: false })
                .mockResolvedValueOnce({ url: 'b', isPrivate: false })
                .mockResolvedValueOnce({ url: 'c', isPrivate: false });

            await service.getRepositoriesStatus(work, user);

            expect(workRepository.update).toHaveBeenCalledWith('work-1', {
                repoVisibility: { data: false, work: false, website: false },
            });
        });

        it('writes the cache when ONLY the website flag changed', async () => {
            const cached: RepoVisibility = { data: false, work: true, website: false };
            const work = buildWork({ repoVisibility: cached });
            const user = buildUser();
            gitFacade.getRepository
                .mockResolvedValueOnce({ url: 'a', isPrivate: false })
                .mockResolvedValueOnce({ url: 'b', isPrivate: true })
                .mockResolvedValueOnce({ url: 'c', isPrivate: true });

            await service.getRepositoriesStatus(work, user);

            expect(workRepository.update).toHaveBeenCalledWith('work-1', {
                repoVisibility: { data: false, work: true, website: true },
            });
        });

        it('falls back to isPrivate=true when a repo entry is missing from the results array', async () => {
            // This is a defence-in-depth pin: the source uses
            // `results.find((r) => r.type === 'X')?.isPrivate ?? true`.
            // A future widening that admits arbitrary repo roles would
            // expose this fallback. We verify the cache row uses `true`
            // for every role when every gitFacade call returns null.
            const work = buildWork({ repoVisibility: undefined });
            const user = buildUser();
            gitFacade.getRepository.mockResolvedValue(null);

            await service.getRepositoriesStatus(work, user);

            expect(workRepository.update).toHaveBeenCalledWith('work-1', {
                repoVisibility: { data: true, work: true, website: true },
            });
        });
    });

    describe('updateRepositoryVisibility', () => {
        const buildUpdated = (overrides: Partial<{ url: string; isPrivate: boolean }> = {}) => ({
            url: 'https://github.com/owner/repo',
            isPrivate: true,
            ...overrides,
        });

        it.each([
            ['data', 'data-repo', 'data-owner'],
            ['work', 'main-repo', 'data-owner'],
            ['website', 'website-repo', 'website-owner'],
        ] as const)(
            'forwards the correct (owner, repoName, {isPrivate}, ctx) tuple for repoType=%s',
            async (repoType, repoName, owner) => {
                const work = buildWork();
                const user = buildUser();
                gitFacade.updateRepository.mockResolvedValue(
                    buildUpdated({ url: `https://x/${repoName}`, isPrivate: true }),
                );

                await service.updateRepositoryVisibility(
                    work,
                    user,
                    repoType,
                    true,
                );

                expect(gitFacade.updateRepository).toHaveBeenCalledWith(
                    owner,
                    repoName,
                    { isPrivate: true },
                    {
                        userId: 'user-1',
                        providerId: 'github',
                        workId: 'work-1',
                    },
                );
            },
        );

        it('throws "Invalid repository type" on unknown repoType (no facade call)', async () => {
            const work = buildWork();
            const user = buildUser();

            await expect(
                service.updateRepositoryVisibility(work, user, 'invalid' as any, true),
            ).rejects.toThrow('Invalid repository type');
            expect(gitFacade.updateRepository).not.toHaveBeenCalled();
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('uses the upstream-reported isPrivate (NOT the requested value) in the cache write', async () => {
            // Pinned: GitHub may refuse a privacy change (e.g. on a
            // free tier private-repo limit). The upstream response is
            // the source of truth — caching the requested value would
            // diverge from reality.
            const work = buildWork();
            const user = buildUser();
            gitFacade.updateRepository.mockResolvedValue(
                buildUpdated({ isPrivate: false }), // upstream refused
            );

            await service.updateRepositoryVisibility(work, user, 'data', true);

            expect(workRepository.update).toHaveBeenCalledWith('work-1', {
                repoVisibility: { data: false, work: true, website: true },
            });
        });

        it('seeds a fresh visibility object when work.repoVisibility is undefined', async () => {
            // The initial visibility is a private-by-default seed
            // (`{data:true, work:true, website:true}`) so that updating
            // a single repo does not leak unset values.
            const work = buildWork({ repoVisibility: undefined });
            const user = buildUser();
            gitFacade.updateRepository.mockResolvedValue(
                buildUpdated({ isPrivate: false }),
            );

            await service.updateRepositoryVisibility(work, user, 'website', false);

            expect(workRepository.update).toHaveBeenCalledWith('work-1', {
                repoVisibility: { data: true, work: true, website: false },
            });
        });

        it('preserves the other two flags when updating one role (cache patch, not replace)', async () => {
            const cached: RepoVisibility = { data: false, work: false, website: true };
            const work = buildWork({ repoVisibility: cached });
            const user = buildUser();
            gitFacade.updateRepository.mockResolvedValue(
                buildUpdated({ isPrivate: true }),
            );

            await service.updateRepositoryVisibility(work, user, 'work', true);

            expect(workRepository.update).toHaveBeenCalledWith('work-1', {
                repoVisibility: { data: false, work: true, website: true },
            });
        });

        it('does NOT mutate the work.repoVisibility object in-place (uses spread copy)', async () => {
            // Pinned: the source uses `{ ...currentVisibility }` to
            // produce a fresh object before writing. Mutating in place
            // would defeat TypeORM change detection in some flows.
            const cached: RepoVisibility = { data: false, work: false, website: true };
            const work = buildWork({ repoVisibility: cached });
            const user = buildUser();
            gitFacade.updateRepository.mockResolvedValue(
                buildUpdated({ isPrivate: true }),
            );

            await service.updateRepositoryVisibility(work, user, 'data', true);

            expect(cached).toEqual({ data: false, work: false, website: true });
            // The cache write argument must not be the same reference.
            const writtenPayload = workRepository.update.mock.calls[0][1] as {
                repoVisibility: RepoVisibility;
            };
            expect(writtenPayload.repoVisibility).not.toBe(cached);
        });

        it('returns the populated RepositoryStatus envelope from the upstream values', async () => {
            const work = buildWork();
            const user = buildUser();
            gitFacade.updateRepository.mockResolvedValue(
                buildUpdated({
                    url: 'https://github.com/data-owner/data-repo',
                    isPrivate: true,
                }),
            );

            const result = await service.updateRepositoryVisibility(
                work,
                user,
                'data',
                true,
            );

            expect(result).toEqual({
                type: 'data',
                name: 'data-repo',
                url: 'https://github.com/data-owner/data-repo',
                isPrivate: true,
                exists: true,
            });
        });

        it('always sets exists=true on the returned status (the call IS the existence proof)', async () => {
            // Pinned: a successful updateRepository call presupposes the
            // repo exists — the response envelope must reflect that even
            // if a future caller forgets to re-query getRepositoriesStatus.
            const work = buildWork();
            const user = buildUser();
            gitFacade.updateRepository.mockResolvedValue(
                buildUpdated({ isPrivate: false }),
            );

            const result = await service.updateRepositoryVisibility(
                work,
                user,
                'website',
                false,
            );

            expect(result.exists).toBe(true);
        });

        it('propagates a gitFacade.updateRepository rejection verbatim (no swallowing, no cache write)', async () => {
            // Pinned: in CONTRAST to getRepositoriesStatus (which
            // tolerates 404s), the update path MUST surface failures
            // so the UI can render an error toast. A future widening
            // to retry-with-backoff would be a deliberate change.
            const work = buildWork();
            const user = buildUser();
            const err = new Error('forbidden');
            gitFacade.updateRepository.mockRejectedValue(err);

            await expect(
                service.updateRepositoryVisibility(work, user, 'data', true),
            ).rejects.toBe(err);
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('forwards user.id, work.gitProvider, and work.id into the upstream context envelope', async () => {
            const work = buildWork({ id: 'w-x', gitProvider: 'bitbucket' as any });
            const user = buildUser({ id: 'u-x' });
            gitFacade.updateRepository.mockResolvedValue(buildUpdated());

            await service.updateRepositoryVisibility(work, user, 'data', true);

            expect(gitFacade.updateRepository.mock.calls[0][3]).toEqual({
                userId: 'u-x',
                providerId: 'bitbucket',
                workId: 'w-x',
            });
        });
    });
});
