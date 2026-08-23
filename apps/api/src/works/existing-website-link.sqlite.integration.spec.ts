jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { WorkCustomDomainRepository } from '@ever-works/agent/database';
import { DomainEnvironment, Work, WorkCustomDomain } from '@ever-works/agent/entities';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { DataSource, EntitySchema } from 'typeorm';
import { ScopeContextService } from '../scope';
import { ExistingWebsiteLinkService } from './existing-website-link.service';

const workSchema = new EntitySchema<Work>({
    name: 'Work',
    target: Work,
    tableName: 'works',
    columns: {
        id: { type: String, primary: true },
        userId: { type: String },
        tenantId: { type: String, nullable: true },
        organizationId: { type: String, nullable: true },
        website: { type: String, nullable: true },
    },
});

const customDomainSchema = new EntitySchema<WorkCustomDomain>({
    name: 'WorkCustomDomain',
    target: WorkCustomDomain,
    tableName: 'work_custom_domains',
    columns: {
        id: { type: String, primary: true, generated: 'uuid' },
        workId: { type: String },
        domain: { type: String },
        environment: {
            type: String,
            default: DomainEnvironment.PRODUCTION,
        },
        verified: { type: Boolean, default: false },
        provider: { type: String, nullable: true },
        createdAt: { type: Date, createDate: true },
        updatedAt: { type: Date, updateDate: true },
    },
    uniques: [{ columns: ['workId', 'domain'] }],
});

describe('ExistingWebsiteLinkService file-backed SQLite concurrency', () => {
    const workId = '00000000-0000-0000-0000-0000000000aa';
    const userId = '00000000-0000-0000-0000-0000000000bb';
    const tenantId = '00000000-0000-0000-0000-0000000000cc';
    const organizationId = '00000000-0000-0000-0000-0000000000dd';

    let temporaryDirectory: string;
    let primaryDataSource: DataSource;
    let secondaryDataSource: DataSource;
    const modules: TestingModule[] = [];

    async function createDataSource(database: string, synchronize: boolean): Promise<DataSource> {
        const dataSource = new DataSource({
            type: 'better-sqlite3',
            database,
            entities: [workSchema, customDomainSchema],
            synchronize,
            prepareDatabase(connection) {
                connection.pragma('journal_mode = WAL');
                connection.pragma('busy_timeout = 1');
            },
        });
        return dataSource.initialize();
    }

    async function createService(dataSource: DataSource): Promise<{
        service: ExistingWebsiteLinkService;
        scope: ScopeContextService;
    }> {
        const ownership = {
            ensureIsOwner: jest.fn().mockResolvedValue({
                work: { id: workId, userId, tenantId, organizationId } as Work,
                member: null,
                role: 'owner',
                isCreator: true,
            }),
        };
        const module = await Test.createTestingModule({
            providers: [
                ExistingWebsiteLinkService,
                ScopeContextService,
                { provide: WorkOwnershipService, useValue: ownership },
                { provide: getDataSourceToken(), useValue: dataSource },
            ],
        }).compile();
        modules.push(module);
        return {
            service: module.get(ExistingWebsiteLinkService),
            scope: module.get(ScopeContextService),
        };
    }

    function link(
        instance: { service: ExistingWebsiteLinkService; scope: ScopeContextService },
        url: string,
    ) {
        return instance.scope.runWith({ tenantId, organizationId }, () =>
            instance.service.linkExistingWebsite(workId, userId, url),
        );
    }

    beforeEach(async () => {
        temporaryDirectory = mkdtempSync(join(tmpdir(), 'existing-website-link-'));
        const database = join(temporaryDirectory, 'website-link.sqlite');
        primaryDataSource = await createDataSource(database, true);
        secondaryDataSource = await createDataSource(database, false);
        await primaryDataSource.getRepository(Work).insert({
            id: workId,
            userId,
            tenantId,
            organizationId,
            website: null,
        });
    });

    afterEach(async () => {
        await Promise.all(modules.splice(0).map((module) => module.close()));
        if (secondaryDataSource?.isInitialized) await secondaryDataSource.destroy();
        if (primaryDataSource?.isInitialized) await primaryDataSource.destroy();
        rmSync(temporaryDirectory, { recursive: true, force: true });
    });

    it('converges identical links from two independent service/DataSource instances', async () => {
        const first = await createService(primaryDataSource);
        const second = await createService(secondaryDataSource);

        const results = await Promise.all([
            link(first, 'https://ever.works'),
            link(second, 'https://EVER.WORKS/'),
        ]);

        expect(results.map((result) => result.created).sort()).toEqual([false, true]);
        expect(results).toEqual([
            expect.objectContaining({ url: 'https://ever.works', verified: false }),
            expect.objectContaining({ url: 'https://ever.works', verified: false }),
        ]);
        await expect(primaryDataSource.getRepository(WorkCustomDomain).count()).resolves.toBe(1);
        await expect(
            primaryDataSource.getRepository(Work).findOneByOrFail({ id: workId }),
        ).resolves.toMatchObject({ website: 'https://ever.works' });
    });

    it('keeps the first database claim and returns 409 for a different concurrent URL', async () => {
        const first = await createService(primaryDataSource);
        const second = await createService(secondaryDataSource);

        const results = await Promise.allSettled([
            link(first, 'https://ever.works'),
            link(second, 'https://other.works'),
        ]);
        const fulfilled = results.filter(
            (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof link>>> =>
                result.status === 'fulfilled',
        );
        const rejected = results.filter(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
        );

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(ConflictException);
        const stored = await primaryDataSource.getRepository(Work).findOneByOrFail({ id: workId });
        expect(stored.website).toBe(fulfilled[0].value.url);
        await expect(primaryDataSource.getRepository(WorkCustomDomain).find()).resolves.toEqual([
            expect.objectContaining({ domain: new URL(fulfilled[0].value.url).hostname }),
        ]);
    });

    it('reuses the verified legacy case variant without changing existing duplicates', async () => {
        await primaryDataSource.getRepository(WorkCustomDomain).save([
            {
                id: '00000000-0000-0000-0000-000000000001',
                workId,
                domain: 'EVER.WORKS',
                environment: DomainEnvironment.PRODUCTION,
                verified: false,
                provider: 'legacy',
                createdAt: new Date('2026-01-01T00:00:00Z'),
                updatedAt: new Date('2026-01-01T00:00:00Z'),
            },
            {
                id: '00000000-0000-0000-0000-000000000002',
                workId,
                domain: 'Ever.Works',
                environment: DomainEnvironment.PRODUCTION,
                verified: true,
                provider: 'manual',
                createdAt: new Date('2026-02-01T00:00:00Z'),
                updatedAt: new Date('2026-02-01T00:00:00Z'),
            },
        ]);
        const instance = await createService(primaryDataSource);

        await expect(link(instance, 'https://ever.works')).resolves.toMatchObject({
            domain: 'ever.works',
            created: false,
            verified: true,
        });
        await expect(
            primaryDataSource.getRepository(WorkCustomDomain).find({
                order: { id: 'ASC' },
            }),
        ).resolves.toEqual([
            expect.objectContaining({ domain: 'EVER.WORKS', verified: false, provider: 'legacy' }),
            expect.objectContaining({ domain: 'Ever.Works', verified: true, provider: 'manual' }),
        ]);
    });

    it('reuses a verified mixed-case row when the database identity is NOCASE', async () => {
        await primaryDataSource.query(
            'CREATE UNIQUE INDEX uq_work_domain_nocase ON work_custom_domains (workId, domain COLLATE NOCASE)',
        );
        await primaryDataSource.getRepository(WorkCustomDomain).save({
            workId,
            domain: 'Ever.Works',
            environment: DomainEnvironment.PRODUCTION,
            verified: true,
            provider: 'manual',
        });
        const instance = await createService(primaryDataSource);

        await expect(link(instance, 'https://ever.works')).resolves.toMatchObject({
            created: false,
            verified: true,
        });
        await expect(primaryDataSource.getRepository(WorkCustomDomain).find()).resolves.toEqual([
            expect.objectContaining({ domain: 'Ever.Works', verified: true, provider: 'manual' }),
        ]);
    });

    it('converges a passive link with the supported domain repository write path', async () => {
        const instance = await createService(primaryDataSource);
        const domainRepository = new WorkCustomDomainRepository(
            secondaryDataSource.getRepository(WorkCustomDomain),
        );

        const [linkResult, domainResult] = await Promise.all([
            link(instance, 'https://ever.works'),
            domainRepository.addDomain(workId, 'Ever.Works', 'manual'),
        ]);

        expect(linkResult).toMatchObject({ domain: 'ever.works' });
        expect(domainResult.domain).toBe('ever.works');
        await expect(primaryDataSource.getRepository(WorkCustomDomain).find()).resolves.toEqual([
            expect.objectContaining({ domain: 'ever.works' }),
        ]);
    });
});
