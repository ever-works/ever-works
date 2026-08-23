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
            userId,
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
            update: jest.fn().mockImplementation(async (_criteria, patch) => {
                if (transactionWork) transactionWork.website = patch.website;
                return { affected: 1, raw: {}, generatedMaps: [] };
            }),
            save: jest.fn().mockImplementation(async (value) => value),
        };
        const dataSourceOptions = { type: 'postgres' };
        let storedDomain = options.existingDomain ?? null;
        let pendingDomain: Record<string, unknown> | undefined;
        const insertBuilder = {
            insert: jest.fn(),
            into: jest.fn(),
            values: jest.fn(),
            onConflict: jest.fn(),
            returning: jest.fn(),
            execute: jest.fn(),
        };
        insertBuilder.insert.mockReturnValue(insertBuilder);
        insertBuilder.into.mockReturnValue(insertBuilder);
        insertBuilder.values.mockImplementation((value) => {
            pendingDomain = value;
            return insertBuilder;
        });
        insertBuilder.onConflict.mockReturnValue(insertBuilder);
        insertBuilder.returning.mockReturnValue(insertBuilder);
        insertBuilder.execute.mockImplementation(async () => {
            storedDomain = { id: 'domain-1', ...pendingDomain };
            return {
                identifiers: [{ id: 'domain-1' }],
                generatedMaps: [{ id: 'domain-1' }],
                raw: [{ id: 'domain-1' }],
            };
        });
        const domainRepository = {
            manager: { connection: { options: dataSourceOptions } },
            find: jest.fn().mockImplementation(async () => (storedDomain ? [storedDomain] : [])),
            create: jest.fn().mockImplementation((value) => ({ id: 'domain-1', ...value })),
            save: jest.fn().mockImplementation(async (value) => {
                storedDomain = value;
                return value;
            }),
            createQueryBuilder: jest.fn().mockReturnValue(insertBuilder),
        };
        const manager = {
            getRepository: jest.fn().mockImplementation((entity) => {
                if (entity === Work) return workRepository;
                if (entity === WorkCustomDomain) return domainRepository;
                throw new Error('Unexpected entity');
            }),
        };
        const dataSource = {
            options: dataSourceOptions,
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
            insertBuilder,
            manager,
            ownedWork,
            ownership,
            scopeContext,
            service,
            transactionWork,
            workRepository,
        };
    }

    function createLocklessRaceHarness() {
        const ownedWork = { id: workId, userId, tenantId, organizationId };
        let website: string | null = null;
        const domains = new Map<string, Record<string, unknown>>();
        let releaseDomainReads!: () => void;
        const domainReadGate = new Promise<void>((resolve) => {
            releaseDomainReads = resolve;
        });
        const ownership = {
            ensureIsOwner: jest.fn().mockResolvedValue({ work: ownedWork }),
        };
        const scopeContext = {
            getTenantId: jest.fn().mockReturnValue(tenantId),
            getOrganizationId: jest.fn().mockReturnValue(organizationId),
        };
        const workRepository = {
            findOne: jest.fn().mockImplementation(async () => ({ ...ownedWork, website })),
            update: jest.fn().mockImplementation(async (_criteria, patch) => {
                if (website !== null) return { affected: 0, raw: {}, generatedMaps: [] };
                website = patch.website;
                return { affected: 1, raw: {}, generatedMaps: [] };
            }),
            save: jest.fn().mockImplementation(async (work) => {
                website = work.website;
                return work;
            }),
        };
        const domainRepository = {
            find: jest.fn().mockImplementation(async ({ where }) => {
                const raw = where.domain as {
                    _objectLiteralParameters?: { canonicalDomain?: string };
                };
                const canonicalDomain = raw._objectLiteralParameters?.canonicalDomain ?? '';
                const snapshot = domains.get(canonicalDomain);
                await domainReadGate;
                return snapshot ? [snapshot] : [];
            }),
            create: jest.fn().mockImplementation((value) => ({
                id: `domain-${value.domain}`,
                ...value,
            })),
            save: jest.fn().mockImplementation(async (value) => {
                if (domains.has(value.domain)) {
                    const error = new Error('UNIQUE constraint failed');
                    Object.assign(error, { code: 'SQLITE_CONSTRAINT' });
                    throw error;
                }
                domains.set(value.domain, value);
                return value;
            }),
        };
        const manager = {
            getRepository: jest.fn().mockImplementation((entity) => {
                if (entity === Work) return workRepository;
                if (entity === WorkCustomDomain) return domainRepository;
                throw new Error('Unexpected entity');
            }),
        };
        const dataSource = {
            options: { type: 'sqlite' },
            transaction: jest.fn().mockImplementation(async (callback) => callback(manager)),
        };
        const service = new ExistingWebsiteLinkService(
            ownership as any,
            scopeContext as any,
            dataSource as any,
        );

        return {
            domains,
            domainRepository,
            getWebsite: () => website,
            releaseDomainReads,
            service,
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
        expect(h.domainRepository.find).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ workId }),
            }),
        );
        expect(h.domainRepository.create).toHaveBeenCalledWith({
            workId,
            domain: 'ever.works',
            environment: 'production',
            verified: false,
            provider: undefined,
        });
        expect(h.insertBuilder.onConflict).toHaveBeenCalledWith('("workId", "domain") DO NOTHING');
        expect(h.domainRepository.save).not.toHaveBeenCalled();
        expect(h.workRepository.update).toHaveBeenCalledWith(
            expect.objectContaining({
                id: workId,
                userId,
                tenantId,
                organizationId,
                website: expect.anything(),
            }),
            { website: 'https://ever.works' },
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
                userId,
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
        expect(h.workRepository.update).not.toHaveBeenCalled();
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
        expect(h.workRepository.update).toHaveBeenCalledWith(
            expect.objectContaining({ id: workId, userId, tenantId, organizationId }),
            { website: 'https://ever.works' },
        );
    });

    it('keeps a PostgreSQL transaction usable when the canonical domain writer wins', async () => {
        const h = createHarness();
        const racedDomain = {
            id: 'domain-race-winner',
            workId,
            domain: 'ever.works',
            verified: true,
            provider: 'manual',
        };
        h.domainRepository.find.mockResolvedValueOnce([]).mockResolvedValueOnce([racedDomain]);
        h.insertBuilder.execute.mockResolvedValueOnce({
            identifiers: [],
            generatedMaps: [],
            raw: [],
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
        expect(h.workRepository.update).toHaveBeenCalledWith(
            expect.objectContaining({ id: workId, userId, tenantId, organizationId }),
            { website: 'https://ever.works' },
        );
        expect(h.domainRepository.save).not.toHaveBeenCalled();
    });

    it('refuses to overwrite a different existing website', async () => {
        const h = createHarness({
            transactionWork: {
                id: workId,
                userId,
                tenantId,
                organizationId,
                website: 'https://other.example',
            },
        });

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(h.domainRepository.find).not.toHaveBeenCalled();
        expect(h.domainRepository.save).not.toHaveBeenCalled();
        expect(h.workRepository.update).not.toHaveBeenCalled();
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
        expect(h.domainRepository.find).not.toHaveBeenCalled();
    });

    it('keeps an ownership transfer opaque at the locked transactional reread', async () => {
        const h = createHarness({
            transactionWork: {
                id: workId,
                userId: '00000000-0000-0000-0000-0000000000ee',
                tenantId,
                organizationId,
                website: null,
            },
        });

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).rejects.toMatchObject({
            status: 404,
            response: expect.objectContaining({ message: 'Work not found' }),
        });
        expect(h.domainRepository.find).not.toHaveBeenCalled();
        expect(h.domainRepository.save).not.toHaveBeenCalled();
        expect(h.workRepository.update).not.toHaveBeenCalled();
    });

    it('rereads after a lost null-website claim and returns idempotent success', async () => {
        const unclaimed = { id: workId, userId, tenantId, organizationId, website: null };
        const winner = {
            id: workId,
            userId,
            tenantId,
            organizationId,
            website: 'https://ever.works',
        };
        const h = createHarness({ transactionWork: unclaimed });
        h.workRepository.findOne.mockResolvedValueOnce(unclaimed).mockResolvedValueOnce(winner);
        h.workRepository.update.mockResolvedValueOnce({
            affected: 0,
            raw: {},
            generatedMaps: [],
        });

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).resolves.toMatchObject({ url: 'https://ever.works' });
        expect(h.workRepository.findOne).toHaveBeenCalledTimes(2);
    });

    it('keeps lost ownership opaque after a zero-row website claim', async () => {
        const unclaimed = { id: workId, userId, tenantId, organizationId, website: null };
        const h = createHarness({ transactionWork: unclaimed });
        h.workRepository.findOne.mockResolvedValueOnce(unclaimed).mockResolvedValueOnce({
            ...unclaimed,
            userId: '00000000-0000-0000-0000-0000000000ee',
        });
        h.workRepository.update.mockResolvedValueOnce({
            affected: 0,
            raw: {},
            generatedMaps: [],
        });

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).rejects.toMatchObject({
            status: 404,
            response: expect.objectContaining({ message: 'Work not found' }),
        });
        expect(h.domainRepository.find).not.toHaveBeenCalled();
    });

    it('returns 409 after a zero-row claim when a different URL won', async () => {
        const unclaimed = { id: workId, userId, tenantId, organizationId, website: null };
        const h = createHarness({ transactionWork: unclaimed });
        h.workRepository.findOne
            .mockResolvedValueOnce(unclaimed)
            .mockResolvedValueOnce({ ...unclaimed, website: 'https://other.works' });
        h.workRepository.update.mockResolvedValueOnce({
            affected: 0,
            raw: {},
            generatedMaps: [],
        });

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(h.domainRepository.find).not.toHaveBeenCalled();
    });

    it('retries a SQLite BUSY failure and rereads through a fresh transaction', async () => {
        const h = createHarness();
        h.dataSource.options.type = 'better-sqlite3';
        h.dataSource.transaction.mockRejectedValueOnce(
            Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }),
        );

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).resolves.toMatchObject({ url: 'https://ever.works' });
        expect(h.dataSource.transaction).toHaveBeenCalledTimes(2);
    });

    it('retries only the expected WorkCustomDomain SQLite uniqueness race', async () => {
        const h = createHarness();
        h.dataSource.options.type = 'better-sqlite3';
        h.dataSource.transaction.mockRejectedValueOnce(
            Object.assign(
                new Error(
                    'UNIQUE constraint failed: work_custom_domains.workId, work_custom_domains.domain',
                ),
                { code: 'SQLITE_CONSTRAINT_UNIQUE' },
            ),
        );

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).resolves.toMatchObject({ url: 'https://ever.works' });
        expect(h.dataSource.transaction).toHaveBeenCalledTimes(2);
    });

    it('does not retry an unrelated SQLite constraint failure', async () => {
        const h = createHarness();
        h.dataSource.options.type = 'better-sqlite3';
        const error = Object.assign(new Error('CHECK constraint failed: unrelated_column'), {
            code: 'SQLITE_CONSTRAINT_CHECK',
        });
        h.dataSource.transaction.mockRejectedValue(error);

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).rejects.toBe(error);
        expect(h.dataSource.transaction).toHaveBeenCalledTimes(1);
    });

    it('bounds SQLite lock retries and surfaces exhaustion without a write', async () => {
        const h = createHarness();
        h.dataSource.options.type = 'better-sqlite3';
        const error = Object.assign(new Error('database is locked'), { code: 'SQLITE_LOCKED' });
        h.dataSource.transaction.mockRejectedValue(error);

        await expect(
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ).rejects.toBe(error);
        expect(h.dataSource.transaction).toHaveBeenCalledTimes(6);
        expect(h.workRepository.update).not.toHaveBeenCalled();
    });

    it('converges identical concurrent links on a lockless driver', async () => {
        const h = createLocklessRaceHarness();
        const combined = Promise.all([
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
        ]);

        await new Promise<void>((resolve) => setImmediate(resolve));
        h.releaseDomainReads();

        await expect(combined).resolves.toEqual([
            expect.objectContaining({ url: 'https://ever.works', created: true }),
            expect.objectContaining({ url: 'https://ever.works', created: false }),
        ]);
        expect(h.domains.size).toBe(1);
        expect(h.domainRepository.save).toHaveBeenCalledTimes(1);
        expect(h.getWebsite()).toBe('https://ever.works');
    });

    it('never overwrites a different concurrent link on a lockless driver', async () => {
        const h = createLocklessRaceHarness();
        const combined = Promise.allSettled([
            h.service.linkExistingWebsite(workId, userId, 'https://ever.works'),
            h.service.linkExistingWebsite(workId, userId, 'https://other.works'),
        ]);

        await new Promise<void>((resolve) => setImmediate(resolve));
        h.releaseDomainReads();

        const [first, second] = await combined;
        expect(first).toMatchObject({
            status: 'fulfilled',
            value: expect.objectContaining({ url: 'https://ever.works', created: true }),
        });
        expect(second).toMatchObject({
            status: 'rejected',
            reason: expect.any(ConflictException),
        });
        expect([...h.domains.keys()]).toEqual(['ever.works']);
        expect(h.getWebsite()).toBe('https://ever.works');
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
