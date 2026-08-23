jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {},
}));

import { ConflictException } from '@nestjs/common';
import { WorkCustomDomainRepository } from '@ever-works/agent/database';
import { DomainEnvironment, Work, WorkCustomDomain } from '@ever-works/agent/entities';
import { DataSource, EntitySchema, type QueryRunner } from 'typeorm';
import { ScopeContextService } from '../scope';
import { ExistingWebsiteLinkService } from './existing-website-link.service';

const postgresUrl = process.env.EVER_WORKS_POSTGRES_RACE_TEST_URL;
const describePostgres = postgresUrl ? describe : describe.skip;

function assertDedicatedTestDatabase(url: string): void {
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1)).toLowerCase();
    if (!/(^|[-_])test($|[-_])/.test(databaseName)) {
        throw new Error(
            'EVER_WORKS_POSTGRES_RACE_TEST_URL must point to a dedicated database whose name contains "test"',
        );
    }
}

const workSchema = new EntitySchema<Work>({
    name: 'Work',
    target: Work,
    tableName: 'works',
    columns: {
        id: { type: 'uuid', primary: true },
        userId: { type: 'uuid' },
        tenantId: { type: 'uuid', nullable: true },
        organizationId: { type: 'uuid', nullable: true },
        website: { type: String, nullable: true },
    },
});

const customDomainSchema = new EntitySchema<WorkCustomDomain>({
    name: 'WorkCustomDomain',
    target: WorkCustomDomain,
    tableName: 'work_custom_domains',
    columns: {
        id: { type: 'uuid', primary: true, generated: 'uuid' },
        workId: { type: 'uuid' },
        domain: { type: String },
        environment: { type: String, default: DomainEnvironment.PRODUCTION },
        verified: { type: Boolean, default: false },
        provider: { type: String, nullable: true },
        createdAt: { type: 'timestamptz', createDate: true },
        updatedAt: { type: 'timestamptz', updateDate: true },
    },
    uniques: [{ columns: ['workId', 'domain'] }],
});

describePostgres('ExistingWebsiteLinkService PostgreSQL domain race', () => {
    const userId = '00000000-0000-0000-0000-0000000000bb';
    const tenantId = '00000000-0000-0000-0000-0000000000cc';
    const organizationId = '00000000-0000-0000-0000-0000000000dd';
    const sameUrlWorkId = '00000000-0000-0000-0000-0000000000a1';
    const differentUrlWorkId = '00000000-0000-0000-0000-0000000000a2';
    const passiveApplicationName = 'ever_works_passive_link_test';
    const advisoryLockKey = 2183;

    let passiveDataSource: DataSource;
    let domainWriterDataSource: DataSource;
    let controlRunner: QueryRunner | undefined;
    let controlLockHeld = false;

    async function createDataSource(
        applicationName: string,
        synchronize: boolean,
    ): Promise<DataSource> {
        return new DataSource({
            type: 'postgres',
            url: postgresUrl as string,
            entities: [workSchema, customDomainSchema],
            synchronize,
            dropSchema: synchronize,
            extra: { application_name: applicationName, max: 3 },
        }).initialize();
    }

    function createService(dataSource: DataSource, workId: string) {
        const scope = new ScopeContextService();
        const ownership = {
            ensureIsOwner: jest.fn().mockResolvedValue({
                work: { id: workId, userId, tenantId, organizationId } as Work,
                member: null,
                role: 'owner',
                isCreator: true,
            }),
        };
        return {
            scope,
            service: new ExistingWebsiteLinkService(ownership as never, scope, dataSource),
        };
    }

    function link(instance: ReturnType<typeof createService>, workId: string, url: string) {
        return instance.scope.runWith({ tenantId, organizationId }, () =>
            instance.service.linkExistingWebsite(workId, userId, url),
        );
    }

    async function waitForPassiveInsertToBlock(): Promise<void> {
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const rows = (await domainWriterDataSource.query(
                `SELECT 1
                   FROM pg_locks AS lock
                   JOIN pg_stat_activity AS activity ON activity.pid = lock.pid
                  WHERE activity.application_name = $1
                    AND lock.locktype = 'advisory'
                    AND lock.granted = false
                  LIMIT 1`,
                [passiveApplicationName],
            )) as unknown[];
            if (rows.length > 0) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('Passive domain insert did not reach the advisory-lock race barrier');
    }

    async function releaseControlLock(): Promise<void> {
        if (!controlRunner || !controlLockHeld) return;
        await controlRunner.query('SELECT pg_advisory_unlock($1)', [advisoryLockKey]);
        controlLockHeld = false;
    }

    beforeAll(async () => {
        assertDedicatedTestDatabase(postgresUrl as string);
        passiveDataSource = await createDataSource(passiveApplicationName, true);
        domainWriterDataSource = await createDataSource('ever_works_domain_writer_test', false);
        await passiveDataSource.getRepository(Work).insert([
            {
                id: sameUrlWorkId,
                userId,
                tenantId,
                organizationId,
                website: null,
            },
            {
                id: differentUrlWorkId,
                userId,
                tenantId,
                organizationId,
                website: null,
            },
        ]);
        await passiveDataSource.query(`
            CREATE OR REPLACE FUNCTION hold_passive_domain_insert()
            RETURNS trigger AS $trigger$
            BEGIN
                IF NEW.provider IS NULL THEN
                    PERFORM pg_advisory_xact_lock(${advisoryLockKey});
                END IF;
                RETURN NEW;
            END;
            $trigger$ LANGUAGE plpgsql
        `);
        await passiveDataSource.query(`
            CREATE TRIGGER hold_passive_domain_insert
            BEFORE INSERT ON work_custom_domains
            FOR EACH ROW EXECUTE FUNCTION hold_passive_domain_insert()
        `);
    });

    afterEach(async () => {
        await releaseControlLock();
        if (controlRunner) {
            await controlRunner.release();
            controlRunner = undefined;
        }
    });

    afterAll(async () => {
        await releaseControlLock();
        if (controlRunner) await controlRunner.release();
        if (domainWriterDataSource?.isInitialized) await domainWriterDataSource.destroy();
        if (passiveDataSource?.isInitialized) await passiveDataSource.destroy();
    });

    it('commits the website when addDomain wins the same-domain insert race', async () => {
        controlRunner = domainWriterDataSource.createQueryRunner();
        await controlRunner.connect();
        await controlRunner.query('SELECT pg_advisory_lock($1)', [advisoryLockKey]);
        controlLockHeld = true;

        const passive = createService(passiveDataSource, sameUrlWorkId);
        const passiveLink = link(passive, sameUrlWorkId, 'https://ever.works');
        await waitForPassiveInsertToBlock();

        const domainWriter = new WorkCustomDomainRepository(
            domainWriterDataSource.getRepository(WorkCustomDomain),
        );
        const winner = await domainWriter.addDomain(sameUrlWorkId, 'Ever.Works', 'manual');
        expect(winner).toMatchObject({ domain: 'ever.works', provider: 'manual' });

        await releaseControlLock();
        await expect(passiveLink).resolves.toMatchObject({
            workId: sameUrlWorkId,
            url: 'https://ever.works',
            domain: 'ever.works',
            created: false,
        });
        await expect(
            passiveDataSource.getRepository(Work).findOneByOrFail({ id: sameUrlWorkId }),
        ).resolves.toMatchObject({ website: 'https://ever.works' });
        await expect(
            passiveDataSource.getRepository(WorkCustomDomain).countBy({ workId: sameUrlWorkId }),
        ).resolves.toBe(1);
    });

    it('keeps one URL and returns 409 for a different concurrent PostgreSQL link', async () => {
        const first = createService(passiveDataSource, differentUrlWorkId);
        const second = createService(domainWriterDataSource, differentUrlWorkId);
        const results = await Promise.allSettled([
            link(first, differentUrlWorkId, 'https://ever.works'),
            link(second, differentUrlWorkId, 'https://other.works'),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.filter(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        expect(rejected).toHaveLength(1);
        expect(rejected[0].reason).toBeInstanceOf(ConflictException);

        const stored = await passiveDataSource
            .getRepository(Work)
            .findOneByOrFail({ id: differentUrlWorkId });
        expect(['https://ever.works', 'https://other.works']).toContain(stored.website);
        await expect(
            passiveDataSource
                .getRepository(WorkCustomDomain)
                .countBy({ workId: differentUrlWorkId }),
        ).resolves.toBe(1);
    });
});
