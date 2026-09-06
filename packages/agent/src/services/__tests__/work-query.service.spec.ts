jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));

import { WorkQueryService } from '../work-query.service';
import { WorkMemberRole, GenerateStatusType } from '@src/entities/types';
import type { WorkDeploymentRepository } from '@src/database/repositories/work-deployment.repository';
import { WorkDeployment } from '@src/entities/work-deployment.entity';

describe('WorkQueryService', () => {
    const user = { id: 'user-1' } as any;

    let workRepository: any;
    let workMemberRepository: any;
    let dataGenerator: any;
    let generationHistoryRepository: any;
    let workDeploymentRepository: jest.Mocked<
        Pick<WorkDeploymentRepository, 'findLatestForWorks' | 'findLatest'>
    >;
    let ownershipService: any;
    let websiteRepositoryState: any;
    let service: WorkQueryService;

    beforeEach(() => {
        workRepository = {
            findAllAccessible: jest.fn(),
            countAllAccessible: jest.fn(),
            existsByUserAndSlug: jest.fn(),
        };
        workMemberRepository = {
            getAccessibleWorkIds: jest.fn(),
            getMemberRolesForWorks: jest.fn(),
        };
        dataGenerator = {};
        generationHistoryRepository = {
            findLatestPositiveItemCounts: jest.fn(),
        };
        workDeploymentRepository = {
            findLatestForWorks: jest.fn().mockResolvedValue(new Map()),
            findLatest: jest.fn().mockResolvedValue(null),
        };
        ownershipService = {};
        websiteRepositoryState = {
            isInitialized: jest.fn().mockResolvedValue(false),
        };

        service = new WorkQueryService(
            workRepository,
            workMemberRepository,
            dataGenerator as any,
            generationHistoryRepository,
            ownershipService as any,
            websiteRepositoryState,
            workDeploymentRepository as unknown as WorkDeploymentRepository,
        );
    });

    it('workItems answers a Repository Work with an empty list — no clone of the wrapped code repository', async () => {
        // Self-build slice D (EW-766): a read is not refused, it is simply
        // empty; what must not happen is `getItems` cloning somebody's code
        // repository into the shared checkout to discover there are no items.
        const work = { id: 'w-repo', kind: 'repo', userId: user.id } as any;
        ownershipService.ensureCanView = jest.fn().mockResolvedValue({ work });
        dataGenerator.getItems = jest.fn();

        const result = await service.workItems('w-repo', user);

        expect(result).toEqual({ status: 'success', items: [] });
        expect(ownershipService.ensureCanView).toHaveBeenCalledWith('w-repo', user.id);
        expect(dataGenerator.getItems).not.toHaveBeenCalled();
    });

    it('recovers the last known positive items count for errored works', async () => {
        const work = {
            id: 'dir-1',
            userId: user.id,
            owner: 'ever-works',
            itemsCount: 0,
            generateStatus: { status: GenerateStatusType.ERROR },
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
        } as any;

        workMemberRepository.getAccessibleWorkIds.mockResolvedValue([]);
        workRepository.findAllAccessible.mockResolvedValue([work]);
        workRepository.countAllAccessible.mockResolvedValue(1);
        workMemberRepository.getMemberRolesForWorks.mockResolvedValue(new Map());
        generationHistoryRepository.findLatestPositiveItemCounts.mockResolvedValue(
            new Map([['dir-1', 42]]),
        );

        const result = await service.getWorks({}, user);

        expect(generationHistoryRepository.findLatestPositiveItemCounts).toHaveBeenCalledWith([
            'dir-1',
        ]);
        expect(result.works[0]).toEqual(
            expect.objectContaining({
                id: 'dir-1',
                itemsCount: 42,
                userRole: WorkMemberRole.OWNER,
            }),
        );
    });

    it('does not override zero counts for completed works', async () => {
        const work = {
            id: 'dir-2',
            userId: user.id,
            owner: 'ever-works',
            itemsCount: 0,
            generateStatus: { status: GenerateStatusType.GENERATED },
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
        } as any;

        workMemberRepository.getAccessibleWorkIds.mockResolvedValue([]);
        workRepository.findAllAccessible.mockResolvedValue([work]);
        workRepository.countAllAccessible.mockResolvedValue(1);
        workMemberRepository.getMemberRolesForWorks.mockResolvedValue(new Map());
        generationHistoryRepository.findLatestPositiveItemCounts.mockResolvedValue(new Map());

        const result = await service.getWorks({}, user);

        expect(generationHistoryRepository.findLatestPositiveItemCounts).toHaveBeenCalledWith([]);
        expect(result.works[0]).toEqual(
            expect.objectContaining({
                id: 'dir-2',
                itemsCount: 0,
            }),
        );
    });

    it('separates historical failures from a paused, ready current projection', async () => {
        const work = {
            id: 'dir-health',
            userId: user.id,
            owner: 'ever-works',
            website: 'https://recovered-site.ever.works',
            deploymentState: 'READY',
            scheduledStatus: 'paused',
            generateStatus: {
                status: GenerateStatusType.ERROR,
                error: 'Unknown remote target: TemplateRepository',
            },
            generationStartedAt: new Date('2026-05-01T10:00:00.000Z'),
            generationFinishedAt: new Date('2026-05-01T10:05:00.000Z'),
            itemsCount: 12,
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
        } as any;
        const deployment = Object.assign(new WorkDeployment(), {
            state: 'TIMEOUT',
            startedAt: new Date('2026-05-01T10:06:00.000Z'),
            completedAt: new Date('2026-05-01T10:16:00.000Z'),
        });

        workMemberRepository.getAccessibleWorkIds.mockResolvedValue([]);
        workRepository.findAllAccessible.mockResolvedValue([work]);
        workRepository.countAllAccessible.mockResolvedValue(1);
        workMemberRepository.getMemberRolesForWorks.mockResolvedValue(new Map());
        generationHistoryRepository.findLatestPositiveItemCounts.mockResolvedValue(new Map());
        workDeploymentRepository.findLatestForWorks.mockResolvedValue(
            new Map([['dir-health', deployment]]),
        );

        const result = await service.getWorks({}, user);

        expect(result.works[0]).toEqual(
            expect.objectContaining({
                lastRun: {
                    generation: {
                        status: GenerateStatusType.ERROR,
                        startedAt: '2026-05-01T10:00:00.000Z',
                        finishedAt: '2026-05-01T10:05:00.000Z',
                    },
                    deployment: {
                        status: 'TIMEOUT',
                        startedAt: '2026-05-01T10:06:00.000Z',
                        finishedAt: '2026-05-01T10:16:00.000Z',
                    },
                },
                currentHealth: {
                    state: 'paused',
                    deployment: {
                        readiness: 'ready',
                        source: 'deployment_projection',
                        observedAt: null,
                    },
                },
            }),
        );
    });

    it('reports the readiness observation time when the latest deployment completed READY', async () => {
        const work = {
            id: 'dir-ready',
            userId: user.id,
            owner: 'ever-works',
            website: 'https://ready-site.ever.works',
            deploymentState: 'READY',
            itemsCount: 1,
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
        } as any;
        const deployment = Object.assign(new WorkDeployment(), {
            state: 'READY',
            startedAt: new Date('2026-08-22T07:55:00.000Z'),
            completedAt: new Date('2026-08-22T08:00:00.000Z'),
        });

        workMemberRepository.getAccessibleWorkIds.mockResolvedValue([]);
        workRepository.findAllAccessible.mockResolvedValue([work]);
        workRepository.countAllAccessible.mockResolvedValue(1);
        workMemberRepository.getMemberRolesForWorks.mockResolvedValue(new Map());
        generationHistoryRepository.findLatestPositiveItemCounts.mockResolvedValue(new Map());
        workDeploymentRepository.findLatestForWorks.mockResolvedValue(
            new Map([['dir-ready', deployment]]),
        );

        const result = await service.getWorks({}, user);

        expect(result.works[0].currentHealth.deployment).toEqual({
            readiness: 'ready',
            source: 'deployment_projection',
            observedAt: '2026-08-22T08:00:00.000Z',
        });
    });

    /**
     * The list query passes `user.id` straight through to
     * `findAllAccessible` — this test pins that handoff so a future
     * refactor that, say, derives `userId` from a different field can't
     * silently filter out everyone's data.
     */
    it('passes the authenticated user.id through to findAllAccessible', async () => {
        workMemberRepository.getAccessibleWorkIds.mockResolvedValue([]);
        workRepository.findAllAccessible.mockResolvedValue([]);
        workRepository.countAllAccessible.mockResolvedValue(0);
        workMemberRepository.getMemberRolesForWorks.mockResolvedValue(new Map());
        generationHistoryRepository.findLatestPositiveItemCounts.mockResolvedValue(new Map());

        await service.getWorks({ limit: 20, offset: 0 }, user);

        expect(workRepository.findAllAccessible).toHaveBeenCalledTimes(1);
        const arg = workRepository.findAllAccessible.mock.calls[0][0];
        expect(arg.userId).toBe(user.id);
        expect(arg.limit).toBe(20);
        expect(arg.offset).toBe(0);
        expect(arg.memberWorkIds).toEqual([]);

        expect(workRepository.countAllAccessible).toHaveBeenCalledWith(
            expect.objectContaining({ userId: user.id }),
        );
    });

    it('returns Work rows owned by the user with the OWNER role', async () => {
        const ownedWork = {
            id: 'owned-work-1',
            userId: user.id,
            owner: 'work-owner',
            slug: 'my-work',
            name: 'My Work',
            itemsCount: 5,
            generateStatus: { status: GenerateStatusType.GENERATED },
            getRepoOwner: jest.fn().mockReturnValue('work-owner'),
        } as any;

        workMemberRepository.getAccessibleWorkIds.mockResolvedValue([]);
        workRepository.findAllAccessible.mockResolvedValue([ownedWork]);
        workRepository.countAllAccessible.mockResolvedValue(1);
        workMemberRepository.getMemberRolesForWorks.mockResolvedValue(new Map());
        generationHistoryRepository.findLatestPositiveItemCounts.mockResolvedValue(new Map());

        const result = await service.getWorks({}, user);

        expect(result.total).toBe(1);
        expect(result.works).toHaveLength(1);
        expect(result.works[0]).toEqual(
            expect.objectContaining({
                id: 'owned-work-1',
                slug: 'my-work',
                userRole: WorkMemberRole.OWNER,
            }),
        );
    });

    describe('checkSlugAvailability', () => {
        it('reports a free slug as available, scoped to the user', async () => {
            workRepository.existsByUserAndSlug.mockResolvedValue(false);

            const result = await service.checkSlugAvailability('My Awesome Tools', user);

            expect(workRepository.existsByUserAndSlug).toHaveBeenCalledWith(
                user.id,
                'my-awesome-tools',
            );
            expect(result).toEqual({ available: true, slug: 'my-awesome-tools' });
        });

        it('returns the first free `<slug>-N` suggestion when taken', async () => {
            // base + "-2" taken, "-3" free
            workRepository.existsByUserAndSlug.mockImplementation(
                async (_userId: string, slug: string) =>
                    slug === 'awesome-tools' || slug === 'awesome-tools-2',
            );

            const result = await service.checkSlugAvailability('awesome-tools', user);

            expect(result).toEqual({
                available: false,
                slug: 'awesome-tools',
                suggestion: 'awesome-tools-3',
            });
        });

        it('treats an empty/symbol-only slug as unavailable without hitting the repo', async () => {
            const result = await service.checkSlugAvailability('***', user);

            expect(workRepository.existsByUserAndSlug).not.toHaveBeenCalled();
            expect(result).toEqual({ available: false, slug: '' });
        });
    });

    it('returns the authoritative website repository initialization state on getWork', async () => {
        const work = {
            id: 'work-1',
            userId: user.id,
            owner: 'ever-works',
            slug: 'my-work',
            name: 'My Work',
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
        } as any;

        ownershipService.ensureAccess = jest.fn().mockResolvedValue({
            work,
            role: WorkMemberRole.EDITOR,
        });
        websiteRepositoryState.isInitialized.mockResolvedValue(true);

        const result = await service.getWork(work.id, user);

        expect(websiteRepositoryState.isInitialized).toHaveBeenCalledWith(work, user);
        expect(result.work).toEqual(
            expect.objectContaining({
                id: 'work-1',
                userRole: WorkMemberRole.EDITOR,
                websiteRepositoryInitialized: true,
            }),
        );
    });
});
