jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));

import { WorkQueryService } from '../work-query.service';
import { WorkMemberRole, GenerateStatusType } from '@src/entities/types';
import type { WorkDeploymentRepository } from '@src/database/repositories/work-deployment.repository';
import type { WorkCustomDomainRepository } from '@src/database/repositories/work-custom-domain.repository';
import { WorkDeployment, DeploymentEnvironment } from '@src/entities/work-deployment.entity';
import { WorkCustomDomain } from '@src/entities/work-custom-domain.entity';

describe('WorkQueryService', () => {
    const user = { id: 'user-1' } as any;

    let workRepository: any;
    let workMemberRepository: any;
    let dataGenerator: any;
    let generationHistoryRepository: any;
    let workDeploymentRepository: jest.Mocked<
        Pick<
            WorkDeploymentRepository,
            'findLatestForWorks' | 'findLatest' | 'findLatestReadyForWorks'
        >
    >;
    let workCustomDomainRepository: jest.Mocked<
        Pick<WorkCustomDomainRepository, 'findVerifiedProductionForWorks'>
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
            findLatestReadyForWorks: jest.fn().mockResolvedValue(new Map()),
        };
        workCustomDomainRepository = {
            findVerifiedProductionForWorks: jest.fn().mockResolvedValue(new Map()),
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
            workCustomDomainRepository as unknown as WorkCustomDomainRepository,
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

    /**
     * APW-11 T7 (plan §4.4, spec FR-15/FR-19/FR-23) — the Work detail payload
     * gains `appLauncher: { exposed, effectiveExposed, live }` so the exposure
     * toggle renders without a second call. `exposed` is the stored choice
     * (`null` = follow the kind), `effectiveExposed` is what the Work does
     * today (`null ?? (kind === 'app')`), and `live` follows FR-15: an address
     * candidate AND a succeeded production deployment.
     */
    describe('appLauncher exposure projection', () => {
        function buildDeployment(state: string, website?: string): WorkDeployment {
            return Object.assign(new WorkDeployment(), { state, website });
        }

        function buildDomain(domain: string): WorkCustomDomain {
            return Object.assign(new WorkCustomDomain(), {
                domain,
                createdAt: new Date('2026-05-01T00:00:00.000Z'),
            });
        }

        function grantAccess(work: Record<string, unknown>): void {
            ownershipService.ensureAccess = jest.fn().mockResolvedValue({
                work: { getRepoOwner: jest.fn().mockReturnValue('ever-works'), ...work },
                role: WorkMemberRole.EDITOR,
            });
        }

        it('answers the stored choice, the app kind default and liveness in one payload', async () => {
            grantAccess({
                id: 'app-1',
                userId: user.id,
                name: 'Rockets',
                kind: 'app',
                status: 'active',
                managedSubdomain: 'rockets',
                appLauncherExposed: null,
            });
            workDeploymentRepository.findLatestReadyForWorks.mockResolvedValue(
                new Map([['app-1', buildDeployment('READY', 'https://rockets.ever.works/')]]),
            );

            const result = await service.getWork('app-1', user);

            expect(result.work.appLauncher).toEqual({
                exposed: null,
                effectiveExposed: true,
                live: true,
            });
            // One batched read each, scoped to this Work and to production.
            expect(workDeploymentRepository.findLatestReadyForWorks).toHaveBeenCalledWith(
                ['app-1'],
                DeploymentEnvironment.PRODUCTION,
            );
            expect(workCustomDomainRepository.findVerifiedProductionForWorks).toHaveBeenCalledWith([
                'app-1',
            ]);
        });

        it('defaults every other kind to off and lets an explicit choice win', async () => {
            grantAccess({
                id: 'dir-1',
                userId: user.id,
                name: 'Directory',
                kind: 'directory',
                status: 'active',
                managedSubdomain: 'directory',
                appLauncherExposed: null,
            });

            const unset = await service.getWork('dir-1', user);
            expect(unset.work.appLauncher).toEqual({
                exposed: null,
                effectiveExposed: false,
                live: false,
            });

            grantAccess({
                id: 'dir-1',
                userId: user.id,
                name: 'Directory',
                kind: 'directory',
                status: 'active',
                managedSubdomain: 'directory',
                appLauncherExposed: true,
            });
            workDeploymentRepository.findLatestReadyForWorks.mockResolvedValue(
                new Map([['dir-1', buildDeployment('READY')]]),
            );

            const explicit = await service.getWork('dir-1', user);
            expect(explicit.work.appLauncher).toEqual({
                exposed: true,
                effectiveExposed: true,
                live: true,
            });
        });

        it('is live off a verified production domain alone (FR-16 first preference)', async () => {
            grantAccess({
                id: 'dir-2',
                userId: user.id,
                name: 'Directory',
                kind: 'directory',
                status: 'active',
                managedSubdomain: null,
                appLauncherExposed: true,
            });
            workDeploymentRepository.findLatestReadyForWorks.mockResolvedValue(
                new Map([['dir-2', buildDeployment('READY')]]),
            );
            workCustomDomainRepository.findVerifiedProductionForWorks.mockResolvedValue(
                new Map([['dir-2', [buildDomain('rockets.example.test')]]]),
            );

            const result = await service.getWork('dir-2', user);

            expect(result.work.appLauncher?.live).toBe(true);
        });

        it('is live off the address the latest READY deployment reported (FR-16 last)', async () => {
            grantAccess({
                id: 'dir-3',
                userId: user.id,
                name: 'Directory',
                kind: 'directory',
                status: 'active',
                managedSubdomain: null,
                appLauncherExposed: null,
            });
            workDeploymentRepository.findLatestReadyForWorks.mockResolvedValue(
                new Map([['dir-3', buildDeployment('READY', 'https://deployed.example.test/')]]),
            );

            const result = await service.getWork('dir-3', user);

            expect(result.work.appLauncher?.live).toBe(true);
        });

        it('is NOT live without a succeeded production deployment, even with an address (FR-15)', async () => {
            grantAccess({
                id: 'dir-4',
                userId: user.id,
                name: 'Directory',
                kind: 'directory',
                status: 'active',
                managedSubdomain: 'directory',
                appLauncherExposed: true,
            });
            // A preview-only / never-ready history leaves the READY read empty.
            workDeploymentRepository.findLatestReadyForWorks.mockResolvedValue(new Map());
            workCustomDomainRepository.findVerifiedProductionForWorks.mockResolvedValue(
                new Map([['dir-4', [buildDomain('rockets.example.test')]]]),
            );

            const result = await service.getWork('dir-4', user);

            expect(result.work.appLauncher).toEqual({
                exposed: true,
                effectiveExposed: true,
                live: false,
            });
        });

        it('is NOT live when a READY deployment exists but no address candidate does', async () => {
            grantAccess({
                id: 'dir-5',
                userId: user.id,
                name: 'Directory',
                kind: 'directory',
                status: 'active',
                managedSubdomain: '   ',
                appLauncherExposed: null,
            });
            workDeploymentRepository.findLatestReadyForWorks.mockResolvedValue(
                new Map([['dir-5', buildDeployment('READY', '')]]),
            );

            const result = await service.getWork('dir-5', user);

            expect(result.work.appLauncher?.live).toBe(false);
        });

        it('is NOT live for an archived Work, whatever else is true (FR-56, Work-level half)', async () => {
            grantAccess({
                id: 'dir-6',
                userId: user.id,
                name: 'Directory',
                kind: 'directory',
                status: 'archived',
                managedSubdomain: 'directory',
                appLauncherExposed: true,
            });
            workDeploymentRepository.findLatestReadyForWorks.mockResolvedValue(
                new Map([['dir-6', buildDeployment('READY', 'https://directory.ever.works/')]]),
            );
            workCustomDomainRepository.findVerifiedProductionForWorks.mockResolvedValue(
                new Map([['dir-6', [buildDomain('rockets.example.test')]]]),
            );

            const result = await service.getWork('dir-6', user);

            expect(result.work.appLauncher?.live).toBe(false);
        });

        it('still answers the payload when the custom-domain repository is not bound', async () => {
            // An existing positional construction that stops before the new
            // (optional) slot must keep working — it simply cannot see a
            // verified domain.
            const legacy = new WorkQueryService(
                workRepository,
                workMemberRepository,
                dataGenerator as any,
                generationHistoryRepository,
                ownershipService as any,
                websiteRepositoryState,
                workDeploymentRepository as unknown as WorkDeploymentRepository,
            );
            grantAccess({
                id: 'dir-7',
                userId: user.id,
                name: 'Directory',
                kind: 'directory',
                status: 'active',
                managedSubdomain: 'directory',
                appLauncherExposed: null,
            });
            workDeploymentRepository.findLatestReadyForWorks.mockResolvedValue(
                new Map([['dir-7', buildDeployment('READY', 'https://directory.ever.works/')]]),
            );

            const result = await legacy.getWork('dir-7', user);

            expect(result.work.appLauncher).toEqual({
                exposed: null,
                effectiveExposed: false,
                live: true,
            });
        });
    });
});
