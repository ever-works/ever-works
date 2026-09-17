// EW-752 P5.1 (T35b) — the `operator_allowlist_boot` audit row against a
// REAL schema. The sibling boot-audit specs mock `TenantJobRuntimeService`,
// so none of them ever pushed `tenantId = NULL` through TypeORM. That gap
// let the entity (still `tenantId NOT NULL`) drift from migration
// 1781200000000 (nullable): every environment that builds the schema from
// entities (`DATABASE_AUTOMIGRATE=true` → `synchronize`, migrations skipped
// — e2e, compose, CLI) rejected the boot row on every start with
// `NOT NULL constraint failed: tenant_job_runtime_audit.tenantId`.
//
// Only the credential-version service is stubbed (it is not touched by the
// audit paths); the entities, repositories and service are real.

jest.mock('@ever-works/agent/tasks', () => ({
    CredentialVersionService: class CredentialVersionService {},
}));

import { Logger } from '@nestjs/common';
import { DataSource, IsNull, QueryRunner } from 'typeorm';
import {
    TenantJobRuntimeAudit,
    TenantJobRuntimeConfig,
    TenantRuntimeProviderAllowlist,
} from '@ever-works/agent/entities';
import { AddTenantJobRuntimeAudit1781000000000 } from '../../../migrations/1781000000000-AddTenantJobRuntimeAudit';
import { RelaxTenantJobRuntimeAuditTenantNullable1781200000000 } from '../../../migrations/1781200000000-RelaxTenantJobRuntimeAuditTenantNullable';
import { TenantJobRuntimeBootAuditService } from '../tenant-job-runtime-boot-audit.service';
import { TenantJobRuntimeService } from '../tenant-job-runtime.service';

const PER_TENANT_GATING_ENV = 'EVER_WORKS_TENANT_RUNTIME_PER_TENANT_GATING';
const GLOBAL_ALLOWLIST_ENV = 'EVER_WORKS_TENANT_RUNTIME_ALLOWED_PROVIDERS';

const TABLE = 'tenant_job_runtime_audit';
const TENANT_A = '6f1c2a0e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const TENANT_B = 'a7b8c9d0-e1f2-4a3b-9c4d-5e6f7a8b9c0d';

async function tenantIdNullableInDatabase(queryRunner: QueryRunner): Promise<boolean | undefined> {
    const table = await queryRunner.getTable(TABLE);
    return table?.findColumnByName('tenantId')?.isNullable;
}

describe('tenant_job_runtime_audit — boot row against the entity-built schema', () => {
    let ds: DataSource;
    let service: TenantJobRuntimeService;
    let boot: TenantJobRuntimeBootAuditService;

    const originalGating = process.env[PER_TENANT_GATING_ENV];
    const originalGlobal = process.env[GLOBAL_ALLOWLIST_ENV];

    beforeEach(async () => {
        // Same schema path as `DATABASE_AUTOMIGRATE=true`: tables come from
        // the entity decorators alone, no migrations.
        ds = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [
                TenantJobRuntimeAudit,
                TenantJobRuntimeConfig,
                TenantRuntimeProviderAllowlist,
            ],
            synchronize: true,
        });
        await ds.initialize();

        service = new TenantJobRuntimeService(
            ds.getRepository(TenantJobRuntimeConfig),
            ds.getRepository(TenantJobRuntimeAudit),
            {} as any,
            ds.getRepository(TenantRuntimeProviderAllowlist),
            ds,
        );
        boot = new TenantJobRuntimeBootAuditService(service);

        process.env[GLOBAL_ALLOWLIST_ENV] = 'trigger,temporal';
        process.env[PER_TENANT_GATING_ENV] = 'false';

        // Keep the success-path log lines out of the test output.
        jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
        jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    });

    afterEach(async () => {
        if (originalGating === undefined) {
            delete process.env[PER_TENANT_GATING_ENV];
        } else {
            process.env[PER_TENANT_GATING_ENV] = originalGating;
        }
        if (originalGlobal === undefined) {
            delete process.env[GLOBAL_ALLOWLIST_ENV];
        } else {
            process.env[GLOBAL_ALLOWLIST_ENV] = originalGlobal;
        }
        if (ds?.isInitialized) await ds.destroy();
        jest.restoreAllMocks();
    });

    it('declares tenantId nullable in the entity metadata and in the synchronized table', async () => {
        const [column] = ds
            .getMetadata(TenantJobRuntimeAudit)
            .findColumnsWithPropertyPath('tenantId');
        expect(column.isNullable).toBe(true);

        const qr = ds.createQueryRunner();
        try {
            expect(await tenantIdNullableInDatabase(qr)).toBe(true);
        } finally {
            await qr.release();
        }
    });

    it('persists exactly one instance-level boot row with tenantId NULL', async () => {
        const result = await boot.captureBootSnapshot();

        expect(result.wrote).toBe(true);
        const rows = await ds.getRepository(TenantJobRuntimeAudit).find();
        expect(rows).toHaveLength(1);
        expect(rows[0].tenantId).toBeNull();
        expect(rows[0].actorUserId).toBeNull();
        expect(rows[0].action).toBe('operator_allowlist_boot');
        expect(rows[0].after?.['hash']).toBe(result.hash);
    });

    it('dedupes a second boot with the same snapshot against the persisted row', async () => {
        const first = await boot.captureBootSnapshot();
        expect(first.wrote).toBe(true);

        const second = await boot.captureBootSnapshot();

        expect(second).toEqual({ wrote: false, hash: first.hash });
        await expect(ds.getRepository(TenantJobRuntimeAudit).count()).resolves.toBe(1);
    });

    it('boots on a fresh database without logging an error', async () => {
        const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        await boot.onApplicationBootstrap();

        expect(errorSpy).not.toHaveBeenCalled();
        await expect(ds.getRepository(TenantJobRuntimeAudit).count()).resolves.toBe(1);
    });

    it('keeps tenant rows and the instance-level row apart on real reads', async () => {
        const repo = ds.getRepository(TenantJobRuntimeAudit);

        await service.appendAuditRow({
            tenantId: TENANT_A,
            actorUserId: null,
            action: 'operator_allowlist_change',
            before: { providerIds: [] },
            after: { providerIds: ['trigger'] },
            credentialVersion: null,
        });
        await service.appendAuditRow({
            tenantId: TENANT_B,
            actorUserId: null,
            action: 'operator_allowlist_change',
            before: { providerIds: [] },
            after: { providerIds: ['temporal'] },
            credentialVersion: null,
        });
        const { hash } = await boot.captureBootSnapshot();

        const forA = await repo.find({ where: { tenantId: TENANT_A } });
        expect(forA).toHaveLength(1);
        expect(forA[0].tenantId).toBe(TENANT_A);
        expect(forA[0].after).toEqual({ providerIds: ['trigger'] });

        const forB = await repo.find({ where: { tenantId: TENANT_B } });
        expect(forB).toHaveLength(1);
        expect(forB[0].tenantId).toBe(TENANT_B);
        expect(forB[0].after).toEqual({ providerIds: ['temporal'] });

        const instance = await repo.find({ where: { tenantId: IsNull() } });
        expect(instance).toHaveLength(1);
        expect(instance[0].action).toBe('operator_allowlist_boot');

        // A tenant-scoped row carrying the boot action, written later than
        // the real boot row, must never be adopted as the dedupe baseline.
        await repo.save(
            repo.create({
                tenantId: TENANT_A,
                actorUserId: null,
                action: 'operator_allowlist_boot',
                before: null,
                after: { hash: 'tenant-scoped-row' },
                credentialVersion: null,
                occurredAt: new Date('2999-01-01T00:00:00.000Z'),
            }),
        );

        const latest = await service.findLatestBootAudit();
        expect(latest).not.toBeNull();
        expect(latest?.tenantId).toBeNull();
        expect(latest?.after?.['hash']).toBe(hash);
    });
});

describe('tenant_job_runtime_audit — migrations agree with the entity', () => {
    let migrated: DataSource;
    let synchronized: DataSource;

    beforeEach(async () => {
        migrated = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [],
            synchronize: false,
        });
        await migrated.initialize();
        await migrated.query('PRAGMA foreign_keys = ON');
        // Minimal stand-ins for the FK targets the audit migration references.
        await migrated.query('CREATE TABLE "tenants" ("id" varchar PRIMARY KEY)');
        await migrated.query('CREATE TABLE "users" ("id" varchar PRIMARY KEY)');

        synchronized = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [TenantJobRuntimeAudit],
            synchronize: true,
        });
        await synchronized.initialize();
    });

    afterEach(async () => {
        if (migrated?.isInitialized) await migrated.destroy();
        if (synchronized?.isInitialized) await synchronized.destroy();
    });

    it('builds a nullable tenantId on both schema paths and keeps the FKs and index', async () => {
        const qr = migrated.createQueryRunner();
        const syncQr = synchronized.createQueryRunner();
        try {
            await new AddTenantJobRuntimeAudit1781000000000().up(qr);
            await new RelaxTenantJobRuntimeAuditTenantNullable1781200000000().up(qr);

            const migratedNullable = await tenantIdNullableInDatabase(qr);
            const synchronizedNullable = await tenantIdNullableInDatabase(syncQr);
            expect(migratedNullable).toBe(true);
            expect(synchronizedNullable).toBe(migratedNullable);

            const table = await qr.getTable(TABLE);
            expect(table?.indices.map((index) => index.name)).toContain(
                'idx_tenant_job_runtime_audit_tenant_occurred',
            );

            const foreignKeys = (table?.foreignKeys ?? []).map((fk) => ({
                columns: fk.columnNames,
                references: fk.referencedTableName,
                onDelete: fk.onDelete,
            }));
            expect(foreignKeys).toEqual(
                expect.arrayContaining([
                    { columns: ['tenantId'], references: 'tenants', onDelete: 'CASCADE' },
                    { columns: ['actorUserId'], references: 'users', onDelete: 'SET NULL' },
                ]),
            );
        } finally {
            await qr.release();
            await syncQr.release();
        }
    });
});
