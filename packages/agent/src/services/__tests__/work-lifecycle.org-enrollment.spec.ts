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
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
import { TemplateCatalogService } from '@src/template-catalog/template-catalog.service';
import { WorkWebsiteRepositoryStateService } from '../work-website-repository-state.service';
import { EverWorksDeployQuotaService, EverWorksGitProvider, EverWorksDnsService } from '@src/ever-works-providers';
import { ZeroFrictionFunnelService } from '../zero-friction-funnel.service';
import type { Work } from '@src/entities/work.entity';
import type { Organization } from '@src/entities/organization.entity';
import type { User } from '@src/entities/user.entity';

/**
 * Security (EW-711 #27) — cross-tenant org-KB enrollment guard.
 *
 * `updateWork` pairs a Work with an organization-scope KB doc set via
 * `updateDto.organizationId`. Before the fix, any UUID was persisted
 * verbatim, so a caller editing their own Work could enroll it into an
 * organization belonging to ANOTHER tenant and fan the Work's KB into
 * that tenant's org overlay. The guard resolves the target Organization
 * and rejects with NotFoundException (existence-leak-safe) unless its
 * `tenantId` matches the Work's tenant.
 */

const WORK_ID = '00000000-0000-0000-0000-000000000001';
const TENANT_A = '00000000-0000-0000-0000-0000000000aa';
const TENANT_B = '00000000-0000-0000-0000-0000000000bb';
const OWN_ORG_ID = '00000000-0000-0000-0000-0000000000c1';
const FOREIGN_ORG_ID = '00000000-0000-0000-0000-0000000000c2';
const MISSING_ORG_ID = '00000000-0000-0000-0000-0000000000c3';

function buildWork(overrides: Partial<Work> = {}): Work {
    return {
        id: WORK_ID,
        name: 'Acme',
        description: 'Acme directory',
        owner: 'acme',
        organization: false,
        readmeConfig: null,
        userId: 'user-1',
        tenantId: TENANT_A,
        organizationId: null,
        websiteTemplateId: null,
        deployProvider: 'vercel',
        getRepoOwner: () => 'acme',
        ...overrides,
    } as unknown as Work;
}

describe('WorkLifecycleService — org-KB enrollment tenant guard (EW-711 #27)', () => {
    let service: WorkLifecycleService;
    let workRepository: { update: jest.Mock };
    let organizationRepository: { findById: jest.Mock };
    let ownershipService: { ensureCanEdit: jest.Mock };
    let work: Work;

    const user = { id: 'user-1', username: 'user-1' } as unknown as User;

    beforeEach(async () => {
        work = buildWork();

        workRepository = {
            // `updateWork` returns whatever `update` resolves; echo a work-shaped row.
            update: jest.fn().mockImplementation(async (_id: string, data: Record<string, unknown>) => ({
                ...work,
                ...data,
                getRepoOwner: () => 'acme',
            })),
        };
        organizationRepository = { findById: jest.fn() };
        ownershipService = {
            ensureCanEdit: jest.fn().mockResolvedValue({ work, member: null, role: 'owner', isCreator: true }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                WorkLifecycleService,
                { provide: WorkRepository, useValue: workRepository },
                { provide: UserRepository, useValue: {} },
                { provide: OrganizationRepository, useValue: organizationRepository },
                { provide: DataGeneratorService, useValue: {} },
                { provide: MarkdownGeneratorService, useValue: {} },
                { provide: WebsiteGeneratorService, useValue: {} },
                { provide: WebsiteUpdateService, useValue: {} },
                { provide: WorkOwnershipService, useValue: ownershipService },
                { provide: DeployFacadeService, useValue: { getAvailableProviders: () => [] } },
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

    it('rejects enrolling into an organization owned by a DIFFERENT tenant (no persist, leak-safe 404)', async () => {
        organizationRepository.findById.mockResolvedValue({
            id: FOREIGN_ORG_ID,
            tenantId: TENANT_B,
        } as Organization);

        await expect(
            service.updateWork(WORK_ID, { organizationId: FOREIGN_ORG_ID }, user),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(organizationRepository.findById).toHaveBeenCalledWith(FOREIGN_ORG_ID);
        // The cross-tenant organizationId must NEVER reach the DB write.
        expect(workRepository.update).not.toHaveBeenCalled();
    });

    it('rejects enrolling into a non-existent organization with the SAME leak-safe 404', async () => {
        organizationRepository.findById.mockResolvedValue(null);

        await expect(
            service.updateWork(WORK_ID, { organizationId: MISSING_ORG_ID }, user),
        ).rejects.toBeInstanceOf(NotFoundException);

        expect(workRepository.update).not.toHaveBeenCalled();
    });

    it('allows enrolling into an organization in the SAME tenant (legit caller still works)', async () => {
        organizationRepository.findById.mockResolvedValue({
            id: OWN_ORG_ID,
            tenantId: TENANT_A,
        } as Organization);

        const result = await service.updateWork(WORK_ID, { organizationId: OWN_ORG_ID }, user);

        expect(result.status).toBe('success');
        expect(organizationRepository.findById).toHaveBeenCalledWith(OWN_ORG_ID);
        expect(workRepository.update).toHaveBeenCalledTimes(1);
        expect(workRepository.update.mock.calls[0][1]).toMatchObject({ organizationId: OWN_ORG_ID });
    });

    it('clears membership when organizationId is null WITHOUT an org lookup', async () => {
        const result = await service.updateWork(WORK_ID, { organizationId: null }, user);

        expect(result.status).toBe('success');
        // Null is the explicit clear path — must not trigger a tenant probe.
        expect(organizationRepository.findById).not.toHaveBeenCalled();
        expect(workRepository.update).toHaveBeenCalledTimes(1);
        expect(workRepository.update.mock.calls[0][1]).toMatchObject({ organizationId: null });
    });

    it('does not touch organizationId (or probe orgs) when the field is omitted', async () => {
        const result = await service.updateWork(WORK_ID, { name: 'Renamed' }, user);

        expect(result.status).toBe('success');
        expect(organizationRepository.findById).not.toHaveBeenCalled();
        expect(workRepository.update).toHaveBeenCalledTimes(1);
        expect(workRepository.update.mock.calls[0][1]).not.toHaveProperty('organizationId');
    });
});
