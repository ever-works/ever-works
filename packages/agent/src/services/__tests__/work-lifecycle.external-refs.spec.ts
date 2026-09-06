// `github-slugger` is an ESM-only dependency pulled in transitively via
// `MarkdownGeneratorService -> readme-builder`. ts-jest cannot parse its
// `import` syntax, so stub it out — this spec never touches slug building.
jest.mock('github-slugger', () => ({
    __esModule: true,
    default: class {
        slug(s: string) {
            return s;
        }
    },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WORK_EXTERNAL_REFS_MAX_PER_KIND } from '@ever-works/contracts';
import { WorkLifecycleService } from '../work-lifecycle.service';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { UserRepository } from '@src/database/repositories/user.repository';
import { OrganizationRepository } from '@src/database/repositories/organization.repository';
import { DataGeneratorService } from '@src/generators/data-generator/data-generator.service';
import { MarkdownGeneratorService } from '@src/generators/markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from '@src/generators/website-generator/website-generator.service';
import { WebsiteUpdateService } from '@src/generators/website-generator/website-update.service';
import { WorkOwnershipService } from '../work-ownership.service';
import { DeployFacadeService } from '@src/facades/deploy.facade';
import { GitFacadeService } from '@src/facades/git.facade';
import { TemplateCatalogService } from '@src/template-catalog/template-catalog.service';
import { WorkWebsiteRepositoryStateService } from '../work-website-repository-state.service';
import {
    EverWorksDeployQuotaService,
    EverWorksGitProvider,
    EverWorksDnsService,
} from '@src/ever-works-providers';
import { ZeroFrictionFunnelService } from '../zero-friction-funnel.service';
import type { Work } from '@src/entities/work.entity';
import type { User } from '@src/entities/user.entity';

/**
 * `works.externalRefs` write path (the missing half of workId routing).
 *
 * The column routes ingested events to a Work; until now only the account
 * import path could populate it. `PATCH /api/works/:id` now carries it,
 * gated by shape validation and an owner-scoped duplicate-claim check.
 */

const WORK_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_WORK_ID = '00000000-0000-0000-0000-000000000002';

function buildWork(overrides: Partial<Work> = {}): Work {
    return {
        id: WORK_ID,
        name: 'Acme',
        description: 'Acme directory',
        owner: 'acme',
        organization: false,
        readmeConfig: null,
        userId: 'user-1',
        tenantId: null,
        organizationId: null,
        websiteTemplateId: null,
        deployProvider: 'vercel',
        externalRefs: null,
        getRepoOwner: () => 'acme',
        ...overrides,
    } as unknown as Work;
}

describe('WorkLifecycleService — externalRefs claim map', () => {
    let service: WorkLifecycleService;
    let workRepository: { update: jest.Mock; findByUser: jest.Mock };
    let work: Work;

    const user = { id: 'user-1', username: 'user-1' } as unknown as User;

    beforeEach(async () => {
        work = buildWork();

        workRepository = {
            update: jest
                .fn()
                .mockImplementation(async (_id: string, data: Record<string, unknown>) => ({
                    ...work,
                    ...data,
                    getRepoOwner: () => 'acme',
                })),
            findByUser: jest.fn().mockResolvedValue([work]),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WorkLifecycleService,
                { provide: WorkRepository, useValue: workRepository },
                { provide: UserRepository, useValue: {} },
                { provide: OrganizationRepository, useValue: {} },
                { provide: DataGeneratorService, useValue: {} },
                { provide: MarkdownGeneratorService, useValue: {} },
                { provide: WebsiteGeneratorService, useValue: {} },
                { provide: WebsiteUpdateService, useValue: {} },
                {
                    provide: WorkOwnershipService,
                    useValue: {
                        ensureCanEdit: jest
                            .fn()
                            .mockImplementation(async () => ({ work, role: 'owner' })),
                    },
                },
                { provide: DeployFacadeService, useValue: { getAvailableProviders: () => [] } },
                // Self-build slice D (EW-766): only the Repository Work create
                // path probes the git facade; this spec never takes it.
                { provide: GitFacadeService, useValue: {} },
                { provide: TemplateCatalogService, useValue: {} },
                { provide: WorkWebsiteRepositoryStateService, useValue: {} },
                { provide: EverWorksDeployQuotaService, useValue: {} },
                { provide: EverWorksGitProvider, useValue: {} },
                { provide: EverWorksDnsService, useValue: {} },
                { provide: ZeroFrictionFunnelService, useValue: {} },
                { provide: EventEmitter2, useValue: { emit: jest.fn(), emitAsync: jest.fn() } },
            ],
        }).compile();

        service = module.get(WorkLifecycleService);
    });

    /**
     * Review finding (Major, data integrity): a Repository Work's `owner` is
     * the GitHub owner of the wrapped repository, and
     * `WorkRepository.findRepositoryWorksWrapping` filters duplicate
     * registrations on that column. Letting an update change it would hide the
     * existing Work from that check and let a second account register the same
     * repository.
     */
    it('refuses to change the owner of a Repository Work', async () => {
        work = buildWork({ kind: 'repo', owner: 'ever-works' } as Partial<Work>);

        await expect(service.updateWork(WORK_ID, { owner: 'someone-else' }, user)).rejects.toThrow(
            BadRequestException,
        );
        expect(workRepository.update).not.toHaveBeenCalled();
    });

    it('still allows an owner change on every other kind, and a no-op owner on a repo Work', async () => {
        work = buildWork({ kind: 'repo', owner: 'ever-works' } as Partial<Work>);
        const sameOwner = await service.updateWork(WORK_ID, { owner: 'ever-works' }, user);
        expect(sameOwner.status).toBe('success');

        work = buildWork({ owner: 'acme' });
        const otherKind = await service.updateWork(WORK_ID, { owner: 'acme-renamed' }, user);
        expect(otherKind.status).toBe('success');
        expect(workRepository.update.mock.calls.at(-1)?.[1]).toMatchObject({
            owner: 'acme-renamed',
        });
    });

    it('round-trips a claim map through the update path', async () => {
        const result = await service.updateWork(
            WORK_ID,
            { externalRefs: { 'chat-channel': ['C0123456789'], meeting: ['zoom-9981'] } },
            user,
        );

        expect(result.status).toBe('success');
        expect(workRepository.update.mock.calls[0][1]).toMatchObject({
            externalRefs: { 'chat-channel': ['C0123456789'], meeting: ['zoom-9981'] },
        });
        expect(result.work.externalRefs).toEqual({
            'chat-channel': ['C0123456789'],
            meeting: ['zoom-9981'],
        });
    });

    it('clears every claim when the map is null (and skips the duplicate scan)', async () => {
        const result = await service.updateWork(WORK_ID, { externalRefs: null }, user);

        expect(result.status).toBe('success');
        expect(workRepository.findByUser).not.toHaveBeenCalled();
        expect(workRepository.update.mock.calls[0][1]).toMatchObject({ externalRefs: null });
    });

    it('rejects an unknown ref kind with a 400 and never writes', async () => {
        await expect(
            service.updateWork(WORK_ID, { externalRefs: { repo: ['acme/site'] } } as never, user),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(workRepository.update).not.toHaveBeenCalled();
    });

    it('rejects going over the per-kind cap with a 400 and never writes', async () => {
        const overCap = Array.from(
            { length: WORK_EXTERNAL_REFS_MAX_PER_KIND + 1 },
            (_, i) => `C${i}`,
        );

        await expect(
            service.updateWork(WORK_ID, { externalRefs: { 'chat-channel': overCap } }, user),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(workRepository.update).not.toHaveBeenCalled();
    });

    it('rejects a claim another Work of the SAME owner already holds (409, named)', async () => {
        workRepository.findByUser.mockResolvedValue([
            work,
            buildWork({
                id: OTHER_WORK_ID,
                name: 'Support Work',
                externalRefs: { 'chat-channel': ['c-support'] },
            }),
        ]);

        // Case-insensitive: the stored claim is lowercase, the submitted one is not.
        const failure = service.updateWork(
            WORK_ID,
            { externalRefs: { 'chat-channel': ['C-SUPPORT'] } },
            user,
        );

        await expect(failure).rejects.toBeInstanceOf(ConflictException);
        await expect(failure).rejects.toThrow(/Support Work/);
        expect(workRepository.update).not.toHaveBeenCalled();
    });

    it('allows re-saving the Work’s OWN existing claims (self is excluded from the scan)', async () => {
        work.externalRefs = { 'chat-channel': ['C-MINE'] };
        workRepository.findByUser.mockResolvedValue([work]);

        const result = await service.updateWork(
            WORK_ID,
            { externalRefs: { 'chat-channel': ['C-MINE', 'C-NEW'] } },
            user,
        );

        expect(result.status).toBe('success');
        expect(workRepository.update.mock.calls[0][1]).toMatchObject({
            externalRefs: { 'chat-channel': ['C-MINE', 'C-NEW'] },
        });
    });

    it('leaves externalRefs untouched when the field is omitted', async () => {
        const result = await service.updateWork(WORK_ID, { name: 'Renamed' }, user);

        expect(result.status).toBe('success');
        expect(workRepository.findByUser).not.toHaveBeenCalled();
        expect(workRepository.update.mock.calls[0][1]).not.toHaveProperty('externalRefs');
    });
});
