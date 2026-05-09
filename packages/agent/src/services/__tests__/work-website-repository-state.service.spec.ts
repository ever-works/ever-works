import { WorkWebsiteRepositoryStateService } from '../work-website-repository-state.service';
import type { Work } from '@src/entities/work.entity';
import type { User } from '@src/entities/user.entity';

describe('WorkWebsiteRepositoryStateService', () => {
    let gitFacade: {
        hasValidCredentials: jest.Mock;
        repositoryExists: jest.Mock;
    };
    let service: WorkWebsiteRepositoryStateService;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        gitFacade = {
            hasValidCredentials: jest.fn(),
            repositoryExists: jest.fn(),
        };
        service = new WorkWebsiteRepositoryStateService(gitFacade as any);
        // Silence the warn channel; reassert via the spy where needed.
        warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warnSpy.mockRestore();
        jest.clearAllMocks();
    });

    const buildWork = (overrides: Partial<Work> = {}): Work =>
        ({
            id: 'w-1',
            userId: 'creator-1',
            gitProvider: 'github',
            website: null,
            deployProjectId: null,
            websiteTemplateLastCommit: null,
            websiteTemplateLastUpdatedAt: null,
            websiteTemplateLastCheckedAt: null,
            getRepoOwner: jest.fn().mockReturnValue('octocat'),
            getWebsiteRepo: jest.fn().mockReturnValue('octocat-website'),
            ...overrides,
        }) as unknown as Work;

    const buildUser = (overrides: Partial<User> = {}): User =>
        ({ id: 'caller-1', ...overrides }) as User;

    describe('short-circuit on persisted markers', () => {
        // Pinned via parametrised matrix because each marker is an
        // independent "this work is initialised" signal — a future
        // refactor that AND'd them together would silently break the
        // domainType auto-detection paths that depend on this service.
        it.each([
            ['website', { website: 'https://app.example.com' }],
            ['deployProjectId', { deployProjectId: 'prj_xxx' }],
            ['websiteTemplateLastCommit', { websiteTemplateLastCommit: 'sha-1' }],
            [
                'websiteTemplateLastUpdatedAt',
                { websiteTemplateLastUpdatedAt: new Date('2026-01-01T00:00:00Z') },
            ],
            [
                'websiteTemplateLastCheckedAt',
                { websiteTemplateLastCheckedAt: new Date('2026-01-01T00:00:00Z') },
            ],
        ])(
            'returns true and skips gitFacade entirely when %s is truthy',
            async (_marker, partial) => {
                const work = buildWork(partial as Partial<Work>);
                const user = buildUser();

                const result = await service.isInitialized(work, user);

                expect(result).toBe(true);
                expect(gitFacade.hasValidCredentials).not.toHaveBeenCalled();
                expect(gitFacade.repositoryExists).not.toHaveBeenCalled();
                // The work-entity helper methods are also untouched —
                // we never had to compute the owner/repo pair.
                expect((work.getRepoOwner as jest.Mock).mock.calls).toHaveLength(0);
                expect((work.getWebsiteRepo as jest.Mock).mock.calls).toHaveLength(0);
            },
        );

        it('treats every-marker-falsy as a no-short-circuit (proceeds to credentials check)', async () => {
            // Negative-of-the-positive — pins the strict OR semantics.
            const work = buildWork();
            const user = buildUser();
            gitFacade.hasValidCredentials.mockResolvedValue(false);

            await service.isInitialized(work, user);

            expect(gitFacade.hasValidCredentials).toHaveBeenCalledTimes(2);
        });

        it('treats empty-string website as falsy (does NOT short-circuit)', async () => {
            // Pinned because `if (work.website || ...)` uses truthiness;
            // a future swap to `work.website != null` would change this
            // (empty-string would suddenly count as "initialised").
            const work = buildWork({ website: '' });
            const user = buildUser();
            gitFacade.hasValidCredentials.mockResolvedValue(false);

            const result = await service.isInitialized(work, user);

            expect(result).toBe(false);
            expect(gitFacade.hasValidCredentials).toHaveBeenCalled();
        });
    });

    describe('credential iteration over deduped userIds', () => {
        it('forwards both creator userId and caller user.id when distinct (deduped via Set)', async () => {
            const work = buildWork({ userId: 'creator-1' });
            const user = buildUser({ id: 'caller-2' });
            gitFacade.hasValidCredentials.mockResolvedValue(false);

            await service.isInitialized(work, user);

            expect(gitFacade.hasValidCredentials).toHaveBeenCalledTimes(2);
            // Iteration order pinned: caller (user.id) first, creator
            // (work.userId) second — that is the order the source
            // constructs `[user.id, work.userId]` in.
            expect(gitFacade.hasValidCredentials.mock.calls[0][0]).toEqual({
                userId: 'caller-2',
                providerId: 'github',
                workId: 'w-1',
            });
            expect(gitFacade.hasValidCredentials.mock.calls[1][0]).toEqual({
                userId: 'creator-1',
                providerId: 'github',
                workId: 'w-1',
            });
        });

        it('dedupes when caller IS the creator (both userIds collapse to one Set entry)', async () => {
            const work = buildWork({ userId: 'same-1' });
            const user = buildUser({ id: 'same-1' });
            gitFacade.hasValidCredentials.mockResolvedValue(false);

            await service.isInitialized(work, user);

            // Only ONE credentials check — the Set collapsed the duplicate.
            expect(gitFacade.hasValidCredentials).toHaveBeenCalledTimes(1);
            expect(gitFacade.hasValidCredentials.mock.calls[0][0].userId).toBe('same-1');
        });

        it('drops falsy userIds via .filter(Boolean) before iterating', async () => {
            // user.id present, work.userId falsy → only one iteration.
            const work = buildWork({ userId: undefined as any });
            const user = buildUser({ id: 'caller-1' });
            gitFacade.hasValidCredentials.mockResolvedValue(false);

            await service.isInitialized(work, user);

            expect(gitFacade.hasValidCredentials).toHaveBeenCalledTimes(1);
            expect(gitFacade.hasValidCredentials.mock.calls[0][0].userId).toBe('caller-1');
        });

        it('drops empty-string userIds via .filter(Boolean) (truthy-check, not nullish-check)', async () => {
            const work = buildWork({ userId: '' as any });
            const user = buildUser({ id: 'caller-1' });
            gitFacade.hasValidCredentials.mockResolvedValue(false);

            await service.isInitialized(work, user);

            expect(gitFacade.hasValidCredentials).toHaveBeenCalledTimes(1);
            expect(gitFacade.hasValidCredentials.mock.calls[0][0].userId).toBe('caller-1');
        });

        it('returns false (no iterations) when both userIds are falsy and no marker is set', async () => {
            const work = buildWork({ userId: undefined as any });
            const user = buildUser({ id: undefined as any });

            const result = await service.isInitialized(work, user);

            expect(result).toBe(false);
            expect(gitFacade.hasValidCredentials).not.toHaveBeenCalled();
        });

        it('skips repositoryExists for userIds that lack credentials and continues to the next user', async () => {
            const work = buildWork({ userId: 'creator-1' });
            const user = buildUser({ id: 'caller-2' });
            // First user has no creds; second user does.
            gitFacade.hasValidCredentials.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
            gitFacade.repositoryExists.mockResolvedValue(true);

            const result = await service.isInitialized(work, user);

            expect(result).toBe(true);
            // hasValidCredentials called twice (once per user); repositoryExists
            // ONLY called for the user who had creds.
            expect(gitFacade.hasValidCredentials).toHaveBeenCalledTimes(2);
            expect(gitFacade.repositoryExists).toHaveBeenCalledTimes(1);
        });
    });

    describe('repositoryExists branches', () => {
        it('returns true on the first user whose repository exists and short-circuits remaining users', async () => {
            const work = buildWork({ userId: 'creator-1' });
            const user = buildUser({ id: 'caller-2' });
            gitFacade.hasValidCredentials.mockResolvedValue(true);
            // First call returns true → loop exits.
            gitFacade.repositoryExists.mockResolvedValueOnce(true);

            const result = await service.isInitialized(work, user);

            expect(result).toBe(true);
            // repositoryExists called once — the second user is never checked.
            expect(gitFacade.repositoryExists).toHaveBeenCalledTimes(1);
            expect(gitFacade.hasValidCredentials).toHaveBeenCalledTimes(1);
        });

        it('forwards (owner, repo, authOptions) positionally to repositoryExists from work entity helpers', async () => {
            const work = buildWork({ userId: 'creator-1' });
            const user = buildUser({ id: 'caller-1' });
            gitFacade.hasValidCredentials.mockResolvedValue(true);
            gitFacade.repositoryExists.mockResolvedValue(true);

            await service.isInitialized(work, user);

            // Pin the work-entity getter contract: getRepoOwner is called
            // with the literal 'website' role, getWebsiteRepo with no args.
            expect(work.getRepoOwner).toHaveBeenCalledWith('website');
            expect(work.getWebsiteRepo).toHaveBeenCalledWith();
            expect(gitFacade.repositoryExists).toHaveBeenCalledWith('octocat', 'octocat-website', {
                userId: 'caller-1',
                providerId: 'github',
                workId: 'w-1',
            });
        });

        it('continues to the next user when repositoryExists resolves to false', async () => {
            const work = buildWork({ userId: 'creator-1' });
            const user = buildUser({ id: 'caller-2' });
            gitFacade.hasValidCredentials.mockResolvedValue(true);
            gitFacade.repositoryExists.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

            const result = await service.isInitialized(work, user);

            expect(result).toBe(true);
            expect(gitFacade.repositoryExists).toHaveBeenCalledTimes(2);
        });

        it('returns false when every userId has credentials but none of their lookups find the repo', async () => {
            const work = buildWork({ userId: 'creator-1' });
            const user = buildUser({ id: 'caller-2' });
            gitFacade.hasValidCredentials.mockResolvedValue(true);
            gitFacade.repositoryExists.mockResolvedValue(false);

            const result = await service.isInitialized(work, user);

            expect(result).toBe(false);
            expect(gitFacade.repositoryExists).toHaveBeenCalledTimes(2);
        });

        it('warns and continues when repositoryExists rejects with an Error (uses Error.message)', async () => {
            const work = buildWork({ userId: 'creator-1' });
            const user = buildUser({ id: 'caller-2' });
            gitFacade.hasValidCredentials.mockResolvedValue(true);
            // First user's lookup blows up; second user's resolves true.
            gitFacade.repositoryExists
                .mockRejectedValueOnce(new Error('rate-limited'))
                .mockResolvedValueOnce(true);

            const result = await service.isInitialized(work, user);

            expect(result).toBe(true);
            expect(warnSpy).toHaveBeenCalledTimes(1);
            const msg = warnSpy.mock.calls[0][0] as string;
            // Pin the message format: includes the workId for log triage
            // and the underlying error message via Error.message.
            expect(msg).toContain('w-1');
            expect(msg).toContain('rate-limited');
        });

        it('warns and continues when repositoryExists rejects with a non-Error (uses String(error))', async () => {
            const work = buildWork({ userId: 'creator-1' });
            const user = buildUser({ id: 'caller-2' });
            gitFacade.hasValidCredentials.mockResolvedValue(true);
            gitFacade.repositoryExists
                .mockRejectedValueOnce('plain-string-rejection')
                .mockResolvedValueOnce(false);

            const result = await service.isInitialized(work, user);

            expect(result).toBe(false);
            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy.mock.calls[0][0]).toContain('plain-string-rejection');
        });

        it('returns false when every user lookup throws (all swallowed via warn)', async () => {
            const work = buildWork({ userId: 'creator-1' });
            const user = buildUser({ id: 'caller-2' });
            gitFacade.hasValidCredentials.mockResolvedValue(true);
            gitFacade.repositoryExists.mockRejectedValue(new Error('boom'));

            const result = await service.isInitialized(work, user);

            expect(result).toBe(false);
            // One warn per user, no rethrow.
            expect(warnSpy).toHaveBeenCalledTimes(2);
        });

        it('does NOT swallow rejections from hasValidCredentials (only repositoryExists is wrapped in try/catch)', async () => {
            // Pinned current behaviour: the try/catch is scoped narrowly
            // to repositoryExists. A future widening to also wrap the
            // credentials check would be a deliberate change.
            const work = buildWork({ userId: 'creator-1' });
            const user = buildUser({ id: 'caller-1' });
            const err = new Error('credentials-system-down');
            gitFacade.hasValidCredentials.mockRejectedValueOnce(err);

            await expect(service.isInitialized(work, user)).rejects.toBe(err);
            expect(warnSpy).not.toHaveBeenCalled();
        });
    });
});
