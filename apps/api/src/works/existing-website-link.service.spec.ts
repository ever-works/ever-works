jest.mock('@ever-works/agent/entities', () => ({
    DomainEnvironment: { PRODUCTION: 'production' },
    Work: class Work {},
    WorkCustomDomain: class WorkCustomDomain {},
}));
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));

import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { Work, WorkCustomDomain } from '@ever-works/agent/entities';
import { ExistingWebsiteLinkService } from './existing-website-link.service';

describe('ExistingWebsiteLinkService', () => {
    const workId = '00000000-0000-0000-0000-0000000000aa';
    const userId = '00000000-0000-0000-0000-0000000000bb';
    const tenantId = '00000000-0000-0000-0000-0000000000cc';
    const organizationId = '00000000-0000-0000-0000-0000000000dd';

    function createHarness(
        options: {
            activeTenantId?: string | null;
            activeOrganizationId?: string | null;
            ownedWork?: Record<string, unknown>;
            transactionWork?: Record<string, unknown> | null;
            existingDomain?: Record<string, unknown> | null;
        } = {},
    ) {
        const ownedWork = options.ownedWork ?? {
            id: workId,
            tenantId,
            organizationId,
        };
        const transactionWork =
            options.transactionWork === undefined
                ? { ...ownedWork, website: null }
                : options.transactionWork;
        const ownership = {
            ensureIsOwner: jest.fn().mockResolvedValue({ work: ownedWork }),
        };
        const scopeContext = {
            getTenantId: jest
                .fn()
                .mockReturnValue(
                    options.activeTenantId === undefined ? tenantId : options.activeTenantId,
                ),
            getOrganizationId: jest
                .fn()
                .mockReturnValue(
                    options.activeOrganizationId === undefined
                        ? organizationId
                        : options.activeOrganizationId,
                ),
        };
        const workRepository = {
            findOne: jest.fn().mockResolvedValue(transactionWork),
            save: jest.fn().mockImplementation(async (value) => value),
        };
        const domainRepository = {
            findOne: jest.fn().mockResolvedValue(options.existingDomain ?? null),
            create: jest.fn().mockImplementation((value) => ({ id: 'domain-1', ...value })),
            save: jest.fn().mockImplementation(async (value) => value),
        };
        const manager = {
            getRepository: jest.fn().mockImplementation((entity) => {
                if (entity === Work) return workRepository;
                if (entity === WorkCustomDomain) return domainRepository;
                throw new Error('Unexpected entity');
            }),
        };
        const dataSource = {
            options: { type: 'postgres' },
            transaction: jest.fn().mockImplementation(async (callback) => callback(manager)),
        };
        const service = new ExistingWebsiteLinkService(
            ownership as any,
            scopeContext as any,
            dataSource as any,
        );

        return {
            dataSource,
            domainRepository,
            manager,
            ownedWork,
            ownership,
            scopeContext,
            service,
            transactionWork,
            workRepository,
        };
    }

    it('atomically links the canonical URL to the scoped Work and existing domain model', async () => {
        const h = createHarness();

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://EVER.WORKS/'),
        ).resolves.toEqual({
            workId,
            url: 'https://ever.works',
            domain: 'ever.works',
            created: true,
            verified: false,
        });

        expect(h.ownership.ensureIsOwner).toHaveBeenCalledWith(workId, userId);
        expect(h.dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(h.workRepository.findOne).toHaveBeenCalledWith({
            where: { id: workId, tenantId, organizationId },
            loadEagerRelations: false,
            lock: { mode: 'pessimistic_write' },
        });
        expect(h.domainRepository.findOne).toHaveBeenCalledWith({
            where: { workId, domain: 'ever.works' },
        });
        expect(h.domainRepository.create).toHaveBeenCalledWith({
            workId,
            domain: 'ever.works',
            environment: 'production',
            verified: false,
        });
        expect(h.domainRepository.save).toHaveBeenCalledTimes(1);
        expect(h.workRepository.save).toHaveBeenCalledWith(
            expect.objectContaining({ website: 'https://ever.works' }),
        );
    });

    it('is idempotent and preserves an existing domain record', async () => {
        const existingDomain = {
            id: 'domain-1',
            workId,
            domain: 'ever.works',
            verified: true,
            provider: 'manual',
        };
        const h = createHarness({
            transactionWork: {
                id: workId,
                tenantId,
                organizationId,
                website: 'https://ever.works',
            },
            existingDomain,
        });

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).resolves.toEqual({
            workId,
            url: 'https://ever.works',
            domain: 'ever.works',
            created: false,
            verified: true,
        });
        expect(h.domainRepository.create).not.toHaveBeenCalled();
        expect(h.domainRepository.save).not.toHaveBeenCalled();
        expect(h.workRepository.save).not.toHaveBeenCalled();
    });

    it('adds only the website URL when the Work already has the domain record', async () => {
        const h = createHarness({
            existingDomain: {
                id: 'domain-1',
                workId,
                domain: 'ever.works',
                verified: false,
            },
        });

        await h.service.linkExistingWebsite(workId, userId, 'https://ever.works');

        expect(h.domainRepository.create).not.toHaveBeenCalled();
        expect(h.domainRepository.save).not.toHaveBeenCalled();
        expect(h.workRepository.save).toHaveBeenCalledWith(
            expect.objectContaining({ website: 'https://ever.works' }),
        );
    });

    it('refuses to overwrite a different existing website', async () => {
        const h = createHarness({
            transactionWork: {
                id: workId,
                tenantId,
                organizationId,
                website: 'https://other.example',
            },
        });

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(h.domainRepository.findOne).not.toHaveBeenCalled();
        expect(h.domainRepository.save).not.toHaveBeenCalled();
        expect(h.workRepository.save).not.toHaveBeenCalled();
    });

    it.each([
        ['tenant', { activeTenantId: null }],
        ['Organization', { activeOrganizationId: null }],
    ])('requires an active %s scope before resolving the Work', async (_label, options) => {
        const h = createHarness(options);

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(h.ownership.ensureIsOwner).not.toHaveBeenCalled();
        expect(h.dataSource.transaction).not.toHaveBeenCalled();
    });

    it.each([new ForbiddenException(), new NotFoundException()])(
        'turns inaccessible and missing Works into the same opaque 404',
        async (ownershipError) => {
            const h = createHarness();
            h.ownership.ensureIsOwner.mockRejectedValueOnce(ownershipError);

            await expect(
                h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
            ).rejects.toMatchObject({
                status: 404,
                response: expect.objectContaining({ message: 'Work not found' }),
            });
            expect(h.dataSource.transaction).not.toHaveBeenCalled();
        },
    );

    it.each([
        ['tenant', { tenantId: '00000000-0000-0000-0000-0000000000ee' }],
        ['Organization', { organizationId: '00000000-0000-0000-0000-0000000000ee' }],
    ])('returns the same opaque 404 for an owner outside the active %s', async (_label, patch) => {
        const h = createHarness({
            ownedWork: { id: workId, tenantId, organizationId, ...patch },
        });

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).rejects.toMatchObject({
            status: 404,
            response: expect.objectContaining({ message: 'Work not found' }),
        });
        expect(h.dataSource.transaction).not.toHaveBeenCalled();
    });

    it('keeps a concurrently moved or deleted Work opaque inside the transaction', async () => {
        const h = createHarness({ transactionWork: null });

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).rejects.toMatchObject({
            status: 404,
            response: expect.objectContaining({ message: 'Work not found' }),
        });
        expect(h.domainRepository.findOne).not.toHaveBeenCalled();
    });

    it('validates the URL before performing ownership or database lookups', async () => {
        const h = createHarness();

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://127.0.0.1'),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(h.ownership.ensureIsOwner).not.toHaveBeenCalled();
        expect(h.dataSource.transaction).not.toHaveBeenCalled();
    });
});
