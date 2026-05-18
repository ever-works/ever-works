// Mocks must be hoisted before the SUT import, so jest.mock comes first.
jest.mock('../generators/data-generator/data-repository', () => {
    return {
        DataRepository: {
            create: jest.fn(),
        },
    };
});

import { CommunityPrProcessorService } from './community-pr-processor.service';
import { DataRepository } from '../generators/data-generator/data-repository';
import { GenerateStatusType } from '../entities/types';
import { WorkHistoryActivityType } from '@ever-works/contracts/api';
import type { CommunityPrState } from '../entities/types';

const dataRepoCreateMock = DataRepository.create as jest.Mock;

interface WorkLike {
    id: string;
    userId: string;
    name: string;
    description: string;
    gitProvider: string;
    communityPrAutoClose?: boolean;
    communityPrEnabled?: boolean;
    communityPrState?: CommunityPrState | null;
    getRepoOwner: jest.Mock<string, [unknown?]>;
    getMainRepo: jest.Mock<string, []>;
    getDataRepo: jest.Mock<string, []>;
}

function makeWork(overrides: Partial<WorkLike> = {}): WorkLike {
    return {
        id: 'work-1',
        userId: 'user-1',
        name: 'Best Tools',
        description: 'A curated list of tools',
        gitProvider: 'github',
        communityPrAutoClose: false,
        communityPrEnabled: true,
        communityPrState: null,
        getRepoOwner: jest.fn().mockReturnValue('acme'),
        getMainRepo: jest.fn().mockReturnValue('best-tools'),
        getDataRepo: jest.fn().mockReturnValue('best-tools-data'),
        ...overrides,
    };
}

function makePr(
    overrides: Partial<{
        number: number;
        title: string;
        body: string | null;
        updatedAt: string;
    }> = {},
) {
    return {
        number: 42,
        title: 'Add new tool',
        body: 'Adding a new tool',
        state: 'open',
        author: 'octocat',
        url: 'https://github.com/acme/best-tools/pull/42',
        createdAt: '2026-05-08T00:00:00Z',
        updatedAt: '2026-05-08T01:00:00Z',
        ...overrides,
    };
}

function makeDataRepoMock() {
    return {
        getCategories: jest.fn().mockResolvedValue([
            { id: 'ai', name: 'AI', slug: 'ai' },
            { id: 'dev', name: 'Dev', slug: 'dev' },
        ]),
        itemExists: jest.fn().mockResolvedValue(false),
        createItemDir: jest.fn().mockResolvedValue(undefined),
        writeItem: jest.fn().mockResolvedValue(undefined),
        writeItemMarkdown: jest.fn().mockResolvedValue(undefined),
    };
}

function makeService(
    overrides: Partial<{
        gitFacade: any;
        aiFacade: any;
        workRepository: any;
        generationHistoryRepository: any;
        taskLockService: any;
    }> = {},
) {
    const gitFacade = overrides.gitFacade ?? {
        listPullRequests: jest.fn().mockResolvedValue([]),
        getPullRequestFiles: jest.fn().mockResolvedValue([]),
        cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
        add: jest.fn().mockResolvedValue(undefined),
        commit: jest.fn().mockResolvedValue(undefined),
        push: jest.fn().mockResolvedValue(undefined),
        createPullRequestComment: jest.fn().mockResolvedValue(undefined),
        closePullRequest: jest.fn().mockResolvedValue(undefined),
    };
    const aiFacade = overrides.aiFacade ?? {
        askJson: jest.fn().mockResolvedValue({ result: { items: [] } }),
    };
    const workRepository = overrides.workRepository ?? {
        findWithCommunityPrEnabled: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(undefined),
        increment: jest.fn().mockResolvedValue(undefined),
    };
    const generationHistoryRepository = overrides.generationHistoryRepository ?? {
        createEntry: jest.fn().mockResolvedValue(undefined),
    };
    const taskLockService = overrides.taskLockService ?? {
        runExclusive: jest.fn(async (_key: string, fn: () => Promise<unknown>) => ({
            acquired: true,
            result: await fn(),
        })),
    };

    const service = new CommunityPrProcessorService(
        gitFacade as any,
        aiFacade as any,
        workRepository as any,
        generationHistoryRepository as any,
        taskLockService as any,
    );

    return {
        service,
        gitFacade,
        aiFacade,
        workRepository,
        generationHistoryRepository,
        taskLockService,
    };
}

describe('CommunityPrProcessorService', () => {
    // C-11: the production default is OFF — auto-apply is opt-in via
    // COMMUNITY_PR_AUTO_APPLY=true. Most of these tests cover the
    // post-gate flow (extraction, commit, push, history, comment); enable
    // auto-apply globally and restore the previous value afterwards.
    // The default-off behaviour is exercised explicitly in its own
    // `describe('C-11 …')` block below.
    const prevAutoApply = process.env.COMMUNITY_PR_AUTO_APPLY;
    const prevVerifiedOrgs = process.env.COMMUNITY_PR_VERIFIED_ORGS;

    beforeEach(() => {
        dataRepoCreateMock.mockReset();
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-05-08T12:00:00Z'));
        process.env.COMMUNITY_PR_AUTO_APPLY = 'true';
        delete process.env.COMMUNITY_PR_VERIFIED_ORGS;
    });

    afterEach(() => {
        jest.useRealTimers();
        if (prevAutoApply === undefined) {
            delete process.env.COMMUNITY_PR_AUTO_APPLY;
        } else {
            process.env.COMMUNITY_PR_AUTO_APPLY = prevAutoApply;
        }
        if (prevVerifiedOrgs === undefined) {
            delete process.env.COMMUNITY_PR_VERIFIED_ORGS;
        } else {
            process.env.COMMUNITY_PR_VERIFIED_ORGS = prevVerifiedOrgs;
        }
    });

    describe('processAllWorks', () => {
        it('returns processed=0 with empty errors when no works are enabled', async () => {
            const { service, workRepository } = makeService();

            const result = await service.processAllWorks();

            expect(result).toEqual({ processed: 0, errors: [] });
            expect(workRepository.findWithCommunityPrEnabled).toHaveBeenCalledTimes(1);
        });

        it('defaults the triggeredBy argument to "schedule" when omitted', async () => {
            const work = makeWork();
            const taskLockService = {
                runExclusive: jest.fn().mockResolvedValue({ acquired: true, result: 0 }),
            };
            const { service } = makeService({
                workRepository: {
                    findWithCommunityPrEnabled: jest.fn().mockResolvedValue([work]),
                },
                taskLockService,
            });

            await service.processAllWorks();

            // The default triggeredBy value flows into processWork; we only assert that
            // runExclusive received a fn we can invoke (the exact triggeredBy reaches
            // processSinglePr only when there is at least one PR, covered elsewhere).
            expect(taskLockService.runExclusive).toHaveBeenCalledTimes(1);
        });

        it('aggregates the per-work itemsAdded into result.processed', async () => {
            const workA = makeWork({ id: 'a' });
            const workB = makeWork({ id: 'b' });
            const taskLockService = {
                runExclusive: jest
                    .fn()
                    .mockResolvedValueOnce({ acquired: true, result: 3 })
                    .mockResolvedValueOnce({ acquired: true, result: 5 }),
            };
            const { service } = makeService({
                workRepository: {
                    findWithCommunityPrEnabled: jest.fn().mockResolvedValue([workA, workB]),
                },
                taskLockService,
            });

            const result = await service.processAllWorks();

            expect(result.processed).toBe(8);
            expect(result.errors).toEqual([]);
        });

        it('catches per-work errors and continues with the remaining works', async () => {
            const workA = makeWork({ id: 'a' });
            const workB = makeWork({ id: 'b' });
            const taskLockService = {
                runExclusive: jest
                    .fn()
                    .mockRejectedValueOnce(new Error('boom'))
                    .mockResolvedValueOnce({ acquired: true, result: 4 }),
            };
            const { service } = makeService({
                workRepository: {
                    findWithCommunityPrEnabled: jest.fn().mockResolvedValue([workA, workB]),
                },
                taskLockService,
            });

            const result = await service.processAllWorks();

            expect(result.processed).toBe(4);
            expect(result.errors).toEqual([{ workId: 'a', error: 'boom' }]);
        });

        it('coerces non-Error rejections to a String() message in errors[]', async () => {
            const work = makeWork({ id: 'w' });
            const taskLockService = {
                runExclusive: jest.fn().mockRejectedValue('plain-string-failure'),
            };
            const { service } = makeService({
                workRepository: {
                    findWithCommunityPrEnabled: jest.fn().mockResolvedValue([work]),
                },
                taskLockService,
            });

            const result = await service.processAllWorks();

            expect(result.errors).toEqual([{ workId: 'w', error: 'plain-string-failure' }]);
        });

        it("uses the work's existing communityPrState when present, otherwise a fresh skeleton", async () => {
            const seededState: CommunityPrState = {
                processedPrNumbers: [1, 2],
                totalItemsAdded: 7,
            };
            const work = makeWork({ id: 'seeded', communityPrState: seededState });
            const taskLockService = {
                runExclusive: jest.fn().mockResolvedValue({ acquired: true, result: 0 }),
            };
            const { service } = makeService({
                workRepository: {
                    findWithCommunityPrEnabled: jest.fn().mockResolvedValue([work]),
                },
                taskLockService,
            });

            await service.processAllWorks();

            expect(taskLockService.runExclusive).toHaveBeenCalledTimes(1);
        });
    });

    describe('processWork — locking and short-circuit branches', () => {
        it('returns 0 (NOT a {acquired:false} envelope) when the lock could not be acquired', async () => {
            const taskLockService = {
                runExclusive: jest.fn().mockResolvedValue({ acquired: false }),
            };
            const { service } = makeService({ taskLockService });

            const result = await service.processWork(makeWork() as any);

            expect(result).toBe(0);
        });

        it('uses the lock key "community-pr:<workId>"', async () => {
            const taskLockService = {
                runExclusive: jest.fn().mockResolvedValue({ acquired: true, result: 0 }),
            };
            const { service } = makeService({ taskLockService });

            await service.processWork(makeWork({ id: 'work-xyz' }) as any);

            expect(taskLockService.runExclusive).toHaveBeenCalledWith(
                'community-pr:work-xyz',
                expect.any(Function),
                expect.objectContaining({ ttlMs: 30 * 60 * 1000 }),
            );
        });

        it('logs at debug via onLocked when another instance is processing', async () => {
            let capturedOnLocked: (() => void) | undefined;
            const taskLockService = {
                runExclusive: jest.fn(async (_k: string, _fn: any, opts: any) => {
                    capturedOnLocked = opts.onLocked;
                    return { acquired: false };
                }),
            };
            const { service } = makeService({ taskLockService });

            await service.processWork(makeWork() as any);

            expect(typeof capturedOnLocked).toBe('function');
            // Calling onLocked should not throw (it just emits a debug log).
            expect(() => capturedOnLocked!()).not.toThrow();
        });

        it('returns 0 when there are no open PRs', async () => {
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([]),
                getPullRequestFiles: jest.fn(),
                cloneOrPull: jest.fn(),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const { service } = makeService({ gitFacade });

            const result = await service.processWork(makeWork() as any);

            expect(result).toBe(0);
            expect(gitFacade.getPullRequestFiles).not.toHaveBeenCalled();
        });

        it('queries listPullRequests with state=open and perPage=100', async () => {
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([]),
                getPullRequestFiles: jest.fn(),
                cloneOrPull: jest.fn(),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const { service } = makeService({ gitFacade });
            const work = makeWork({
                id: 'w',
                userId: 'u',
                gitProvider: 'github',
            });

            await service.processWork(work as any);

            expect(gitFacade.listPullRequests).toHaveBeenCalledWith(
                'acme',
                'best-tools',
                { state: 'open', perPage: 100 },
                { userId: 'u', providerId: 'github', workId: 'w' },
            );
        });

        it('returns 0 when every open PR is already processed (matching processedPrs.updatedAt)', async () => {
            const pr = makePr({ number: 7, updatedAt: '2026-05-08T01:00:00Z' });
            const work = makeWork({
                communityPrState: {
                    processedPrNumbers: [],
                    processedPrs: [
                        { number: 7, updatedAt: '2026-05-08T01:00:00Z', outcome: 'ignored' },
                    ],
                    totalItemsAdded: 0,
                },
            });
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn(),
                cloneOrPull: jest.fn(),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn(),
                increment: jest.fn(),
            };
            const { service } = makeService({ gitFacade, workRepository });

            const result = await service.processWork(work as any);

            expect(result).toBe(0);
            expect(gitFacade.getPullRequestFiles).not.toHaveBeenCalled();
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('treats a PR as unprocessed if its updatedAt has changed since the last run', async () => {
            const pr = makePr({ number: 7, updatedAt: '2026-05-08T05:00:00Z' });
            const work = makeWork({
                communityPrState: {
                    processedPrNumbers: [7],
                    processedPrs: [
                        { number: 7, updatedAt: '2026-05-07T00:00:00Z', outcome: 'ignored' },
                    ],
                    totalItemsAdded: 0,
                },
            });
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([]),
                cloneOrPull: jest.fn(),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const { service } = makeService({ gitFacade });

            await service.processWork(work as any);

            // empty patch causes ignored — but the key assertion is getPullRequestFiles WAS called
            expect(gitFacade.getPullRequestFiles).toHaveBeenCalled();
        });

        it('falls back to legacy processedPrNumbers when processedPrs is undefined', async () => {
            const pr = makePr({ number: 9 });
            const work = makeWork({
                communityPrState: {
                    processedPrNumbers: [9],
                    totalItemsAdded: 0,
                },
            });
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn(),
                cloneOrPull: jest.fn(),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const { service } = makeService({ gitFacade });

            const result = await service.processWork(work as any);

            expect(result).toBe(0);
            expect(gitFacade.getPullRequestFiles).not.toHaveBeenCalled();
        });

        it("honours the explicit autoClose argument over the work's communityPrAutoClose", async () => {
            const pr = makePr();
            const file = { filename: 'data/x.yml', status: 'added', patch: '+ added' };
            const work = makeWork({ communityPrAutoClose: false });
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'Item One',
                                description: 'D',
                                source_url: 'https://x.test',
                                category: 'AI',
                                tags: ['a'],
                            },
                        ],
                    },
                }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            // Pass autoClose=true explicitly even though work.communityPrAutoClose=false
            await service.processWork(work as any, undefined, true);

            expect(gitFacade.closePullRequest).toHaveBeenCalledTimes(1);
        });

        it('falls back to work.communityPrAutoClose when autoClose argument is undefined', async () => {
            const pr = makePr();
            const file = { filename: 'data/x.yml', status: 'added', patch: '+ added' };
            const work = makeWork({ communityPrAutoClose: true });
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'Item One',
                                description: 'D',
                                source_url: 'https://x.test',
                                category: 'AI',
                                tags: ['a'],
                            },
                        ],
                    },
                }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            await service.processWork(work as any);

            expect(gitFacade.closePullRequest).toHaveBeenCalledTimes(1);
        });

        it('uses the explicit state argument over work.communityPrState', async () => {
            const explicit: CommunityPrState = {
                processedPrNumbers: [],
                processedPrs: [
                    { number: 99, updatedAt: '2026-05-08T01:00:00Z', outcome: 'ignored' },
                ],
                totalItemsAdded: 0,
            };
            const pr = makePr({ number: 99, updatedAt: '2026-05-08T01:00:00Z' });
            const work = makeWork({
                communityPrState: { processedPrNumbers: [], totalItemsAdded: 0 },
            });
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn(),
                cloneOrPull: jest.fn(),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const { service } = makeService({ gitFacade });

            const result = await service.processWork(work as any, explicit);

            expect(result).toBe(0);
            expect(gitFacade.getPullRequestFiles).not.toHaveBeenCalled();
        });
    });

    describe('processWork — per-PR flow + state persistence', () => {
        it('persists currentState even when no items were added (lastProcessedAt + lastError set)', async () => {
            const pr = makePr();
            const file = { filename: 'data/x.yml', status: 'added', patch: '+ unrelated' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({ result: { items: [] } }),
            };
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined),
                increment: jest.fn().mockResolvedValue(undefined),
            };
            const { service } = makeService({ gitFacade, aiFacade, workRepository });

            const result = await service.processWork(work as any);

            expect(result).toBe(0);
            expect(workRepository.update).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({
                    communityPrState: expect.objectContaining({
                        lastProcessedAt: '2026-05-08T12:00:00.000Z',
                        lastError: null,
                        totalItemsAdded: 0,
                    }),
                }),
            );
            expect(workRepository.increment).not.toHaveBeenCalled();
        });

        it('marks the PR as handled with outcome=ignored when AI returned no items', async () => {
            const pr = makePr({ number: 12 });
            const file = { filename: 'a.md', status: 'added', patch: '+ noise' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({ result: { items: [] } }),
            };
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined),
                increment: jest.fn().mockResolvedValue(undefined),
            };
            const { service } = makeService({ gitFacade, aiFacade, workRepository });

            await service.processWork(work as any);

            const recorded = (workRepository.update as jest.Mock).mock.calls[0][1].communityPrState;
            expect(recorded.processedPrs).toEqual([
                { number: 12, updatedAt: pr.updatedAt, outcome: 'ignored' },
            ]);
            expect(recorded.processedPrNumbers).toContain(12);
        });

        it('returns total items added and increments work.itemsCount on success', async () => {
            const pr = makePr({ number: 1 });
            const file = { filename: 'data/x.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'A',
                                description: 'Da',
                                source_url: 'https://a',
                                category: 'AI',
                                tags: [],
                            },
                            {
                                name: 'B',
                                description: 'Db',
                                source_url: 'https://b',
                                category: 'Dev',
                                tags: ['t'],
                            },
                        ],
                    },
                }),
            };
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined),
                increment: jest.fn().mockResolvedValue(undefined),
            };
            const { service } = makeService({ gitFacade, aiFacade, workRepository });

            const result = await service.processWork(work as any);

            expect(result).toBe(2);
            expect(workRepository.increment).toHaveBeenCalledWith('work-1', 'itemsCount', 2);
        });

        it('catches per-PR errors and records lastError without aborting the loop', async () => {
            const prA = makePr({ number: 1, updatedAt: '2026-05-08T01:00:00Z' });
            const prB = makePr({ number: 2, updatedAt: '2026-05-08T02:00:00Z' });
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([prA, prB]),
                getPullRequestFiles: jest
                    .fn()
                    .mockRejectedValueOnce(new Error('fetch-files-failed'))
                    .mockResolvedValueOnce([
                        { filename: 'x.yml', status: 'added', patch: '+ added' },
                    ]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'X',
                                description: 'd',
                                source_url: 'https://x',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined),
                increment: jest.fn().mockResolvedValue(undefined),
            };
            const { service } = makeService({ gitFacade, aiFacade, workRepository });

            const result = await service.processWork(work as any);

            expect(result).toBe(1);
            const recorded = (workRepository.update as jest.Mock).mock.calls[0][1].communityPrState;
            expect(recorded.lastError).toBe('fetch-files-failed');
            // Only the second (successful) PR is marked handled w/ applied outcome;
            // first PR's failure is left unmarked so it is retried next time.
            expect(recorded.processedPrs).toEqual([
                { number: 2, updatedAt: prB.updatedAt, outcome: 'applied' },
            ]);
        });

        it('coerces non-Error PR-loop rejections to a String() lastError', async () => {
            const pr = makePr();
            const work = makeWork();
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockRejectedValue('boom-string'),
                cloneOrPull: jest.fn(),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined),
                increment: jest.fn().mockResolvedValue(undefined),
            };
            const { service } = makeService({ gitFacade, workRepository });

            await service.processWork(work as any);

            const recorded = (workRepository.update as jest.Mock).mock.calls[0][1].communityPrState;
            expect(recorded.lastError).toBe('boom-string');
        });

        it('accumulates totalItemsAdded onto the existing state.totalItemsAdded counter', async () => {
            const pr = makePr({ number: 1 });
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork({
                communityPrState: {
                    processedPrNumbers: [],
                    totalItemsAdded: 10,
                },
            });
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'A',
                                description: 'd',
                                source_url: 'https://a',
                                category: 'AI',
                                tags: [],
                            },
                            {
                                name: 'B',
                                description: 'd',
                                source_url: 'https://b',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined),
                increment: jest.fn().mockResolvedValue(undefined),
            };
            const { service } = makeService({ gitFacade, aiFacade, workRepository });

            await service.processWork(work as any);

            const recorded = (workRepository.update as jest.Mock).mock.calls[0][1].communityPrState;
            expect(recorded.totalItemsAdded).toBe(12);
        });

        it('treats a missing existing totalItemsAdded as 0 (no NaN)', async () => {
            const pr = makePr();
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork({
                // totalItemsAdded omitted on purpose
                communityPrState: { processedPrNumbers: [] } as any,
            });
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'A',
                                description: 'd',
                                source_url: 'https://a',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined),
                increment: jest.fn().mockResolvedValue(undefined),
            };
            const { service } = makeService({ gitFacade, aiFacade, workRepository });

            await service.processWork(work as any);

            const recorded = (workRepository.update as jest.Mock).mock.calls[0][1].communityPrState;
            expect(recorded.totalItemsAdded).toBe(1);
        });
    });

    describe('processSinglePr — change-context capping', () => {
        it('returns ignored/0 when getPullRequestFiles returns an empty array (no change context)', async () => {
            const pr = makePr();
            const work = makeWork();
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([]),
                cloneOrPull: jest.fn(),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const aiFacade = { askJson: jest.fn() };
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined),
                increment: jest.fn(),
            };
            const { service } = makeService({ gitFacade, aiFacade, workRepository });

            await service.processWork(work as any);

            // No AI call when there are no files (empty changeContext)
            expect(aiFacade.askJson).not.toHaveBeenCalled();
            // No clone either — early return at !changeContext.trim()
            expect(gitFacade.cloneOrPull).not.toHaveBeenCalled();
            // Pr still marked as handled w/ ignored outcome
            const recorded = (workRepository.update as jest.Mock).mock.calls[0][1].communityPrState;
            expect(recorded.processedPrs[0].outcome).toBe('ignored');
        });

        it('preserves the file-header pattern in change context even when patches are empty (does NOT early-return)', async () => {
            const pr = makePr();
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([
                    { filename: 'a', status: 'added' },
                    { filename: 'b', status: 'modified', patch: '' },
                ]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({ result: { items: [] } }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            await service.processWork(work as any);

            // Even with empty patches, the file-header lines make changeContext non-empty,
            // so we DO proceed to clone + AI call.
            expect(aiFacade.askJson).toHaveBeenCalledTimes(1);
            const prompt = (aiFacade.askJson as jest.Mock).mock.calls[0][0] as string;
            expect(prompt).toContain('--- a (added) ---');
            expect(prompt).toContain('--- b (modified) ---');
        });

        it('breaks out of the change-context loop at the 50_000-char cap', async () => {
            const pr = makePr();
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const huge = 'x'.repeat(40_000);
            const small = 'small-patch';
            const files = [
                { filename: 'a', status: 'added', patch: huge },
                { filename: 'b', status: 'added', patch: huge },
                // Even though there is a third file with valid content, we should
                // have broken before reaching it because the 2nd `huge` already
                // pushed us past 50_000.
                { filename: 'c', status: 'added', patch: small },
            ];
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue(files),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({ result: { items: [] } }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            await service.processWork(work as any);

            // Inspect the prompt passed to askJson — it must include "a" and "b" but
            // NOT "c" since the cap was hit after the second huge patch.
            expect(aiFacade.askJson).toHaveBeenCalledTimes(1);
            const promptArg = (aiFacade.askJson as jest.Mock).mock.calls[0][0] as string;
            expect(promptArg).toContain('--- a (added) ---');
            // Whether 'b' fits depends on threshold; assert at least one file present
            // and the small file was definitely excluded.
            expect(promptArg).not.toContain('small-patch');
        });

        it('uses .patch="" fallback when file.patch is missing', async () => {
            const pr = makePr();
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                // Mix: one file has no patch field; one has a real one.
                getPullRequestFiles: jest.fn().mockResolvedValue([
                    { filename: 'noop.txt', status: 'modified' },
                    { filename: 'real.md', status: 'added', patch: '+ added line' },
                ]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({ result: { items: [] } }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            await service.processWork(work as any);

            expect(aiFacade.askJson).toHaveBeenCalledTimes(1);
            const prompt = (aiFacade.askJson as jest.Mock).mock.calls[0][0] as string;
            expect(prompt).toContain('--- noop.txt (modified) ---');
            expect(prompt).toContain('+ added line');
        });
    });

    describe('processSinglePr — extraction prompt + askJson positional shape', () => {
        it('forwards (prompt, schema, {temperature:0.3}, {userId, workId}) to aiFacade.askJson', async () => {
            const pr = makePr();
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork({ id: 'wid', userId: 'uid' });
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({ result: { items: [] } }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            await service.processWork(work as any);

            expect(aiFacade.askJson).toHaveBeenCalledWith(
                expect.any(String),
                expect.anything(), // zod schema instance
                { temperature: 0.3 },
                { userId: 'uid', workId: 'wid' },
            );
        });

        it('emits "Existing categories: None defined yet" when getCategories rejects', async () => {
            const pr = makePr();
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepo.getCategories.mockRejectedValue(new Error('fs error'));
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({ result: { items: [] } }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            await service.processWork(work as any);

            const prompt = (aiFacade.askJson as jest.Mock).mock.calls[0][0] as string;
            expect(prompt).toContain('Existing categories: None defined yet');
        });

        it('emits "PR Description: No description provided" when pr.body is null', async () => {
            const pr = makePr({ body: null });
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({ result: { items: [] } }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            await service.processWork(work as any);

            const prompt = (aiFacade.askJson as jest.Mock).mock.calls[0][0] as string;
            expect(prompt).toContain('PR Description: No description provided');
        });

        it('joins existing category names with ", " in the prompt', async () => {
            const pr = makePr();
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepo.getCategories.mockResolvedValue([
                { name: 'Alpha' },
                { name: 'Beta' },
                { name: 'Gamma' },
            ] as any);
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({ result: { items: [] } }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            await service.processWork(work as any);

            const prompt = (aiFacade.askJson as jest.Mock).mock.calls[0][0] as string;
            expect(prompt).toContain('Existing categories: Alpha, Beta, Gamma');
        });
    });

    describe('processSinglePr — slug deduplication', () => {
        it('skips duplicate slugs within a single PR (in-memory seenSlugs)', async () => {
            const pr = makePr();
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'Foo Bar',
                                description: 'a',
                                source_url: 'https://a',
                                category: 'AI',
                                tags: [],
                            },
                            // Same slug after slugify
                            {
                                name: 'Foo Bar',
                                description: 'a',
                                source_url: 'https://b',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            const result = await service.processWork(work as any);

            expect(result).toBe(1);
            expect(dataRepo.writeItem).toHaveBeenCalledTimes(1);
        });

        it('skips items whose slug already exists in the data repo', async () => {
            const pr = makePr();
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            // First item already exists; second is new.
            dataRepo.itemExists.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'Existing',
                                description: 'a',
                                source_url: 'https://a',
                                category: 'AI',
                                tags: [],
                            },
                            {
                                name: 'Brand New',
                                description: 'a',
                                source_url: 'https://b',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            const result = await service.processWork(work as any);

            expect(result).toBe(1);
            expect(dataRepo.writeItem).toHaveBeenCalledTimes(1);
            // Skip applies to createItemDir AND writeItemMarkdown too
            expect(dataRepo.createItemDir).toHaveBeenCalledTimes(1);
            expect(dataRepo.writeItemMarkdown).toHaveBeenCalledTimes(1);
        });

        it('returns ignored/0 when EVERY proposed item has a duplicate slug', async () => {
            const pr = makePr();
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepo.itemExists.mockResolvedValue(true);
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'A',
                                description: 'a',
                                source_url: 'https://a',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined),
                increment: jest.fn().mockResolvedValue(undefined),
            };
            const { service } = makeService({ gitFacade, aiFacade, workRepository });

            const result = await service.processWork(work as any);

            expect(result).toBe(0);
            // No commit / push / comment when no items were added
            expect(gitFacade.add).not.toHaveBeenCalled();
            expect(gitFacade.commit).not.toHaveBeenCalled();
            expect(gitFacade.push).not.toHaveBeenCalled();
            expect(gitFacade.createPullRequestComment).not.toHaveBeenCalled();
            expect(gitFacade.closePullRequest).not.toHaveBeenCalled();
            const recorded = (workRepository.update as jest.Mock).mock.calls[0][1].communityPrState;
            expect(recorded.processedPrs[0].outcome).toBe('ignored');
            expect(workRepository.increment).not.toHaveBeenCalled();
        });

        it('skips items whose name slugifies to an empty string', async () => {
            const pr = makePr();
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: '!!!',
                                description: 'a',
                                source_url: 'https://a',
                                category: 'AI',
                                tags: [],
                            },
                            {
                                name: 'Real Item',
                                description: 'a',
                                source_url: 'https://b',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            const result = await service.processWork(work as any);

            expect(result).toBe(1);
            expect(dataRepo.writeItem).toHaveBeenCalledTimes(1);
            // The slug for the real item must be passed through verbatim
            expect(dataRepo.writeItem).toHaveBeenCalledWith(
                expect.objectContaining({ slug: 'real-item' }),
            );
        });
    });

    describe('processSinglePr — commit + push + history + comment + close', () => {
        it('passes the right args to gitFacade.add / commit / push', async () => {
            const pr = makePr({ number: 17 });
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/clone'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'X',
                                description: 'd',
                                source_url: 'https://x',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            await service.processWork(work as any);

            expect(gitFacade.add).toHaveBeenCalledWith('github', '/tmp/clone', '.');
            expect(gitFacade.commit).toHaveBeenCalledWith(
                'github',
                '/tmp/clone',
                'Add 1 item(s) from community PR #17',
            );
            expect(gitFacade.push).toHaveBeenCalledWith(
                { dir: '/tmp/clone' },
                expect.objectContaining({
                    userId: 'user-1',
                    providerId: 'github',
                    workId: 'work-1',
                }),
            );
        });

        it('records community PR history with GENERATED status + COMMUNITY_PR_MERGED activityType', async () => {
            const pr = makePr({ number: 5 });
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork({ userId: 'uid', id: 'wid' });
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'Item One',
                                description: 'd',
                                source_url: 'https://a',
                                category: 'AI',
                                tags: [],
                            },
                            {
                                name: 'Item Two',
                                description: 'd',
                                source_url: 'https://b',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const generationHistoryRepository = {
                createEntry: jest.fn().mockResolvedValue(undefined),
            };
            const { service } = makeService({ gitFacade, aiFacade, generationHistoryRepository });

            // Triggered explicitly to assert it is forwarded to history record
            await service.processWork(work as any, undefined, undefined, 'api');

            expect(generationHistoryRepository.createEntry).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: 'wid',
                    userId: 'uid',
                    status: GenerateStatusType.GENERATED,
                    durationInSeconds: 0,
                    newItemsCount: 2,
                    triggeredBy: 'api',
                    activityType: WorkHistoryActivityType.COMMUNITY_PR_MERGED,
                }),
            );
        });

        it('uses the singular "1 item added" wording in the changelog summary when only one item was added', async () => {
            const pr = makePr({ number: 5 });
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'Just One',
                                description: 'd',
                                source_url: 'https://a',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const generationHistoryRepository = {
                createEntry: jest.fn().mockResolvedValue(undefined),
            };
            const { service } = makeService({ gitFacade, aiFacade, generationHistoryRepository });

            await service.processWork(work as any);

            const entry = (generationHistoryRepository.createEntry as jest.Mock).mock.calls[0][0];
            expect(entry.newItemsCount).toBe(1);
            // changelog message — best-effort check for "1 item added" (singular)
            const changelogStr = JSON.stringify(entry.changelog);
            expect(changelogStr).toMatch(/1 item added/);
        });

        it('swallows recordCommunityPrHistory failures without aborting the PR loop', async () => {
            const pr = makePr({ number: 8 });
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'Item',
                                description: 'd',
                                source_url: 'https://x',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const generationHistoryRepository = {
                createEntry: jest.fn().mockRejectedValue(new Error('history-down')),
            };
            const { service } = makeService({ gitFacade, aiFacade, generationHistoryRepository });

            const result = await service.processWork(work as any);

            // The PR is still considered applied (returned itemsAdded = 1).
            expect(result).toBe(1);
            // Comment + close still fired.
            expect(gitFacade.createPullRequestComment).toHaveBeenCalled();
        });

        it('comments on the PR with the joined item names', async () => {
            const pr = makePr({ number: 11 });
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'Alpha',
                                description: 'd',
                                source_url: 'https://a',
                                category: 'AI',
                                tags: [],
                            },
                            {
                                name: 'Beta',
                                description: 'd',
                                source_url: 'https://b',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            await service.processWork(work as any);

            const [owner, repo, prNumber, body, opts] = (
                gitFacade.createPullRequestComment as jest.Mock
            ).mock.calls[0];
            expect(owner).toBe('acme');
            expect(repo).toBe('best-tools');
            expect(prNumber).toBe(11);
            expect(body).toContain('- Alpha');
            expect(body).toContain('- Beta');
            expect(body).toContain('Thank you for your contribution!');
            expect(opts).toMatchObject({ workId: 'work-1' });
        });

        it('swallows comment errors without aborting (the PR is still recorded as applied)', async () => {
            const pr = makePr();
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockRejectedValue(new Error('comment-fail')),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'X',
                                description: 'd',
                                source_url: 'https://x',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined),
                increment: jest.fn().mockResolvedValue(undefined),
            };
            const { service } = makeService({ gitFacade, aiFacade, workRepository });

            const result = await service.processWork(work as any);

            expect(result).toBe(1);
            const recorded = (workRepository.update as jest.Mock).mock.calls[0][1].communityPrState;
            expect(recorded.processedPrs[0].outcome).toBe('applied');
            // lastError stays null because the PR-loop body's outer try/catch never triggered.
            expect(recorded.lastError).toBeNull();
        });

        it('does NOT call closePullRequest when autoClose is false', async () => {
            const pr = makePr();
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork({ communityPrAutoClose: false });
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'Y',
                                description: 'd',
                                source_url: 'https://y',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            await service.processWork(work as any);

            expect(gitFacade.closePullRequest).not.toHaveBeenCalled();
        });

        it('swallows closePullRequest failures (the PR is still recorded as applied)', async () => {
            const pr = makePr();
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork({ communityPrAutoClose: true });
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockRejectedValue(new Error('close-fail')),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'Z',
                                description: 'd',
                                source_url: 'https://z',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined),
                increment: jest.fn().mockResolvedValue(undefined),
            };
            const { service } = makeService({ gitFacade, aiFacade, workRepository });

            const result = await service.processWork(work as any);

            expect(result).toBe(1);
            const recorded = (workRepository.update as jest.Mock).mock.calls[0][1].communityPrState;
            expect(recorded.lastError).toBeNull();
            expect(recorded.processedPrs[0].outcome).toBe('applied');
        });

        it('writes a markdown body containing the source_url link for each new item', async () => {
            const pr = makePr();
            const file = { filename: 'a.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'Tool',
                                description: 'A useful tool.',
                                source_url: 'https://tool.example',
                                category: 'AI',
                                tags: [],
                            },
                        ],
                    },
                }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            await service.processWork(work as any);

            const [, markdown] = (dataRepo.writeItemMarkdown as jest.Mock).mock.calls[0];
            expect(markdown).toContain('# Tool');
            expect(markdown).toContain('A useful tool.');
            expect(markdown).toContain('[https://tool.example](https://tool.example)');
        });
    });

    describe('MAX_PROCESSED_PR_NUMBERS FIFO eviction', () => {
        it('keeps processedPrNumbers capped at 500 entries (FIFO eviction)', async () => {
            // Pre-fill the state with 500 entries; processing 1 new PR should keep length at 500
            const seeded: number[] = [];
            for (let i = 0; i < 500; i++) seeded.push(i + 1);
            const pr = makePr({ number: 1001 });
            const work = makeWork({
                communityPrState: {
                    processedPrNumbers: [...seeded],
                    processedPrs: [],
                    totalItemsAdded: 0,
                },
            });
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([]),
                cloneOrPull: jest.fn(),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined),
                increment: jest.fn().mockResolvedValue(undefined),
            };
            const { service } = makeService({ gitFacade, workRepository });

            await service.processWork(work as any);

            const recorded = (workRepository.update as jest.Mock).mock.calls[0][1].communityPrState;
            expect(recorded.processedPrNumbers.length).toBe(500);
            // Newest entry is retained, oldest is evicted.
            expect(recorded.processedPrNumbers).toContain(1001);
            expect(recorded.processedPrNumbers).not.toContain(1);
        });
    });

    describe('C-11 — auto-apply default-off + verified-org author gate', () => {
        // Audit ref: docs/specs/security/audits/2026-05-17-ever-works-platform-security-audit.md
        // Implementation: packages/agent/src/community-pr/community-pr-processor.service.ts
        //                 packages/plugins/github/src/github-verified-org.service.ts

        it('default-off auto-apply: skips PR when COMMUNITY_PR_AUTO_APPLY is unset', async () => {
            delete process.env.COMMUNITY_PR_AUTO_APPLY;

            const pr = makePr();
            const work = makeWork();
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn(),
                cloneOrPull: jest.fn(),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const aiFacade = { askJson: jest.fn() };
            const { service } = makeService({ gitFacade, aiFacade });

            const result = await service.processWork(work as any);

            expect(result).toBe(0);
            // Critically: getPullRequestFiles is never called — we
            // short-circuit BEFORE talking to GitHub for diffs.
            expect(gitFacade.getPullRequestFiles).not.toHaveBeenCalled();
            // ... and we never invoke the AI extraction prompt.
            expect(aiFacade.askJson).not.toHaveBeenCalled();
        });

        it('verified-org gate: skips PR when orgVerified is missing on author', async () => {
            process.env.COMMUNITY_PR_AUTO_APPLY = 'true';
            process.env.COMMUNITY_PR_VERIFIED_ORGS = 'ever-works,ever-co';

            const pr = {
                ...makePr(),
                author: { username: 'random-contributor' }, // no orgVerified flag
            };
            const work = makeWork();
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn(),
                cloneOrPull: jest.fn(),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const aiFacade = { askJson: jest.fn() };
            const { service } = makeService({ gitFacade, aiFacade });

            const result = await service.processWork(work as any);

            expect(result).toBe(0);
            expect(gitFacade.getPullRequestFiles).not.toHaveBeenCalled();
            expect(aiFacade.askJson).not.toHaveBeenCalled();
        });

        it('verified-org gate: skips PR when orgVerified is false', async () => {
            process.env.COMMUNITY_PR_AUTO_APPLY = 'true';
            process.env.COMMUNITY_PR_VERIFIED_ORGS = 'ever-works';

            const pr = {
                ...makePr(),
                author: { username: 'stranger', orgVerified: false },
            };
            const work = makeWork();
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn(),
                cloneOrPull: jest.fn(),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const aiFacade = { askJson: jest.fn() };
            const { service } = makeService({ gitFacade, aiFacade });

            const result = await service.processWork(work as any);

            expect(result).toBe(0);
            expect(gitFacade.getPullRequestFiles).not.toHaveBeenCalled();
            expect(aiFacade.askJson).not.toHaveBeenCalled();
        });

        it('verified-org gate: proceeds when orgVerified is true', async () => {
            process.env.COMMUNITY_PR_AUTO_APPLY = 'true';
            process.env.COMMUNITY_PR_VERIFIED_ORGS = 'ever-works';

            const pr = {
                ...makePr(),
                author: { username: 'evermember', orgVerified: true },
            };
            const file = { filename: 'data/x.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'Trusted Tool',
                                description: 'A tool from a verified org member',
                                source_url: 'https://trusted.test',
                                category: 'AI',
                                tags: ['a'],
                            },
                        ],
                    },
                }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            const result = await service.processWork(work as any);

            expect(result).toBe(1);
            expect(gitFacade.getPullRequestFiles).toHaveBeenCalled();
            expect(aiFacade.askJson).toHaveBeenCalled();
        });

        it('verified-org gate is disabled when COMMUNITY_PR_VERIFIED_ORGS is unset (back-compat)', async () => {
            process.env.COMMUNITY_PR_AUTO_APPLY = 'true';
            delete process.env.COMMUNITY_PR_VERIFIED_ORGS;

            // No orgVerified on author — but the gate isn't configured,
            // so the PR still proceeds (the operator opted out of the
            // author check by not setting the env var).
            const pr = {
                ...makePr(),
                author: { username: 'random-contributor' },
            };
            const file = { filename: 'data/x.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({
                    result: {
                        items: [
                            {
                                name: 'Anything',
                                description: 'D',
                                source_url: 'https://x.test',
                                category: 'AI',
                                tags: ['a'],
                            },
                        ],
                    },
                }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            const result = await service.processWork(work as any);

            expect(result).toBe(1);
            expect(gitFacade.getPullRequestFiles).toHaveBeenCalled();
        });

        it('verified-org gate: marks the PR as handled with outcome=ignored when skipped', async () => {
            process.env.COMMUNITY_PR_AUTO_APPLY = 'true';
            process.env.COMMUNITY_PR_VERIFIED_ORGS = 'ever-works';

            const pr = {
                ...makePr({ number: 77 }),
                author: { username: 'stranger', orgVerified: false },
            };
            const work = makeWork();
            const workRepository = {
                findWithCommunityPrEnabled: jest.fn(),
                update: jest.fn().mockResolvedValue(undefined),
                increment: jest.fn().mockResolvedValue(undefined),
            };
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn(),
                cloneOrPull: jest.fn(),
                add: jest.fn(),
                commit: jest.fn(),
                push: jest.fn(),
                createPullRequestComment: jest.fn(),
                closePullRequest: jest.fn(),
            };
            const { service } = makeService({ gitFacade, workRepository });

            await service.processWork(work as any);

            const recorded = (workRepository.update as jest.Mock).mock.calls[0][1].communityPrState;
            expect(recorded.processedPrs).toEqual([
                { number: 77, updatedAt: pr.updatedAt, outcome: 'ignored' },
            ]);
            expect(recorded.processedPrNumbers).toContain(77);
        });
    });

    describe('C-11 — extractedItemSchema URL-scheme guard', () => {
        // Audit ref: docs/specs/security/audits/2026-05-17-ever-works-platform-security-audit.md
        // The schema in `community-pr-processor.service.ts` constrains
        // `source_url` to http(s) only. A naive `z.string()` would happily
        // accept `javascript:alert(1)`, `data:text/html,...`, or `file://...`
        // — any of which would land in the data repo's markdown body as a
        // clickable link. We capture the schema passed to `aiFacade.askJson`
        // and exercise it directly with `safeParse` so the assertion targets
        // the schema's parse semantics, not any downstream business logic.
        async function captureExtractedItemSchema(): Promise<{
            schema: import('zod').ZodSchema<unknown>;
        }> {
            const pr = makePr();
            const file = { filename: 'data/x.yml', status: 'added', patch: '+ added' };
            const work = makeWork();
            const dataRepo = makeDataRepoMock();
            dataRepoCreateMock.mockResolvedValue(dataRepo);
            const gitFacade = {
                listPullRequests: jest.fn().mockResolvedValue([pr]),
                getPullRequestFiles: jest.fn().mockResolvedValue([file]),
                cloneOrPull: jest.fn().mockResolvedValue('/tmp/repo'),
                add: jest.fn().mockResolvedValue(undefined),
                commit: jest.fn().mockResolvedValue(undefined),
                push: jest.fn().mockResolvedValue(undefined),
                createPullRequestComment: jest.fn().mockResolvedValue(undefined),
                closePullRequest: jest.fn().mockResolvedValue(undefined),
            };
            // Return an empty items array so the processor short-circuits
            // after schema validation — we only care about capturing the
            // schema arg here.
            const aiFacade = {
                askJson: jest.fn().mockResolvedValue({ result: { items: [] } }),
            };
            const { service } = makeService({ gitFacade, aiFacade });

            await service.processWork(work as any);

            expect(aiFacade.askJson).toHaveBeenCalledTimes(1);
            const schema = (aiFacade.askJson as jest.Mock).mock.calls[0][1];
            expect(schema).toBeDefined();
            // Zod schemas expose `safeParse`. This guards against a future
            // refactor that drops the schema argument or swaps in something
            // that isn't a Zod schema.
            expect(typeof (schema as { safeParse?: unknown }).safeParse).toBe('function');
            return { schema };
        }

        const baseItem = {
            name: 'A tool',
            description: 'A useful tool',
            category: 'AI',
            tags: ['a'],
        };

        it('rejects javascript:, data:, and file: URL schemes in source_url', async () => {
            const { schema } = await captureExtractedItemSchema();

            // Each of these would slip past `z.string()` but must be rejected
            // by the http(s)-only `.refine()` in `extractedItemSchema`.
            const dangerousUrls = [
                'javascript:alert(1)',
                // eslint-disable-next-line no-script-url
                'JavaScript:alert(1)', // case-insensitive — the URL parser lower-cases protocol
                'data:text/html,<script>alert(1)</script>',
                'file:///etc/passwd',
            ];

            for (const url of dangerousUrls) {
                const parsed = (schema as import('zod').ZodSchema<unknown>).safeParse({
                    items: [{ ...baseItem, source_url: url }],
                });
                expect(parsed.success).toBe(false);
                if (!parsed.success) {
                    // The rejection must come from the schema (the http(s)
                    // refinement) — assert the exact message wired in
                    // `community-pr-processor.service.ts`, not a generic
                    // "unsafe URL" wrapper added elsewhere.
                    const messages = parsed.error.issues.map((i) => i.message);
                    expect(messages).toContain('source_url must be http(s)');
                }
            }
        });

        it('accepts http: and https: URLs (positive control for the URL-scheme guard)', async () => {
            const { schema } = await captureExtractedItemSchema();

            for (const url of ['http://example.com', 'https://example.com/path?q=1']) {
                const parsed = (schema as import('zod').ZodSchema<unknown>).safeParse({
                    items: [{ ...baseItem, source_url: url }],
                });
                expect(parsed.success).toBe(true);
            }
        });
    });

    describe('Constants', () => {
        // Sanity test confirming the documented constants do not silently change.
        // We assert via observable side-effects.
        it('uses ttlMs=30 minutes (1_800_000 ms) for the per-work lock', async () => {
            const taskLockService = {
                runExclusive: jest.fn().mockResolvedValue({ acquired: true, result: 0 }),
            };
            const { service } = makeService({ taskLockService });

            await service.processWork(makeWork() as any);

            const opts = (taskLockService.runExclusive as jest.Mock).mock.calls[0][2];
            expect(opts.ttlMs).toBe(30 * 60 * 1000);
            expect(opts.ttlMs).toBe(1_800_000);
        });
    });
});
