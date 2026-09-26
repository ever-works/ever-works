import { readFileSync } from 'fs';
import { join } from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import {
    APP_DEPENDENCY_BACKUP_POLICIES,
    APP_DEPENDENCY_BACKUP_STATES,
    APP_DEPENDENCY_INACTIVE_STATUSES,
    APP_DEPENDENCY_KINDS,
    APP_DEPENDENCY_STATUSES,
    APP_DEPENDENCY_TARGETS,
} from '@ever-works/contracts';
import { WorkAppDependency } from '../work-app-dependency.entity';

/**
 * APW-07 T6 — the `WorkAppDependency` entity's shape, pinned against plan §3.2
 * (`plan.md:202-228`), the migration (T7) and the repository (T8).
 *
 * What matters here, in the order T6 states it:
 *
 *  - the **partial unique index** `uq_work_app_dependencies_active
 *    (workId, kind) WHERE status NOT IN ('kept', 'deleted')`. It is NOT a
 *    decorator: plan §3.4:333-338 puts the Postgres form in the migration as
 *    raw SQL, with a SQLite expression-index branch and a MySQL/MariaDB
 *    generated-column branch, because TypeORM's `synchronize` (the in-memory
 *    SQLite test driver) would synthesise a NON-partial duplicate of a
 *    decorated one and then refuse the second `kept` row a released dependency
 *    legitimately leaves behind — the reasoning `workspace_backups` records at
 *    `1791220000000-CreateWorkspaceBackups.ts:26-34`. So this spec asserts the
 *    index where it actually lives (the migration's source, read here) and
 *    asserts the ABSENCE of a decorator that would break the SQLite lane;
 *  - the defaults a fresh row starts with: `attempts` 0, `outputsVersion` 0,
 *    `inSpec` true (`plan.md:212,217,219`);
 *  - the closed sets, read from `@ever-works/contracts` (APW-07 T2) rather
 *    than re-listed, so a column width that cannot hold its longest legal
 *    member fails here.
 */
describe('WorkAppDependency entity', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((column) => column.target === WorkAppDependency);
    const column = (name: string) => columns.find((entry) => entry.propertyName === name);
    const propertyNames = columns.map((entry) => entry.propertyName);

    /** The 29 columns of plan §3.2:206-224, verbatim and complete. */
    const PLAN_COLUMNS = [
        'id',
        'workId',
        'kind',
        'deployTarget',
        'providerPluginId',
        'providerId',
        'status',
        'statusReason',
        'statusDetail',
        'attempts',
        'declared',
        'actualVersion',
        'sizeGiB',
        'configEncrypted',
        'outputsEncrypted',
        'outputsVersion',
        'resourceRefs',
        'inSpec',
        'backupPolicy',
        'backupState',
        'lastBackupAt',
        'backupCheckedAt',
        'lastProvisionedAt',
        'lastCheckedAt',
        'provisionLeaseUntil',
        'tenantId',
        'organizationId',
        'createdAt',
        'updatedAt',
    ];

    /** The columns the plan writes `NOT NULL`. */
    const NOT_NULL_COLUMNS = [
        'workId',
        'kind',
        'deployTarget',
        'providerPluginId',
        'providerId',
        'status',
        'attempts',
        'declared',
        'outputsVersion',
        'inSpec',
        'backupPolicy',
    ];

    /** The five stamps of `plan.md:222` plus the optional value columns. */
    const TIMESTAMP_COLUMNS = [
        'lastBackupAt',
        'backupCheckedAt',
        'lastProvisionedAt',
        'lastCheckedAt',
        'provisionLeaseUntil',
    ];

    const NULLABLE_COLUMNS = [
        'statusReason',
        'statusDetail',
        'actualVersion',
        'sizeGiB',
        'configEncrypted',
        'outputsEncrypted',
        'resourceRefs',
        'backupState',
        ...TIMESTAMP_COLUMNS,
        'tenantId',
        'organizationId',
    ];

    const MIGRATION_SOURCE = readFileSync(
        join(
            __dirname,
            '..',
            '..',
            '..',
            '..',
            '..',
            'apps',
            'api',
            'src',
            'migrations',
            '1792070000000-CreateAppEnvAndDependencies.ts',
        ),
        'utf8',
    );

    describe('table and columns (plan §3.2)', () => {
        it('maps to work_app_dependencies', () => {
            const table = storage.tables.find((entry) => entry.target === WorkAppDependency);

            expect(table?.name).toBe('work_app_dependencies');
        });

        it('declares exactly the 29 columns of plan §3.2, and nothing else', () => {
            expect(columns).toHaveLength(29);
            expect([...propertyNames].sort()).toEqual([...PLAN_COLUMNS].sort());
        });

        it('carries the required columns NOT NULL and the optional ones nullable', () => {
            for (const name of NOT_NULL_COLUMNS) {
                expect(column(name)?.options.nullable).not.toBe(true);
            }

            for (const name of NULLABLE_COLUMNS) {
                expect(column(name)?.options.nullable).toBe(true);
            }
        });

        it('uses the plan’s widths for every bounded string column', () => {
            const widths: Array<[string, number]> = [
                ['kind', 16],
                ['deployTarget', 24],
                ['providerPluginId', 64],
                ['providerId', 64],
                ['status', 16],
                ['statusReason', 48],
                ['actualVersion', 32],
                ['backupPolicy', 16],
                ['backupState', 16],
            ];

            for (const [name, length] of widths) {
                expect(column(name)?.options.type).toBe('varchar');
                expect(column(name)?.options.length).toBe(length);
            }
        });

        it('stores the two envelopes as text, nullable — a managed row carries neither', () => {
            // plan §3.2:230 — `outputsEncrypted` is always NULL for
            // `ever-works-apps` rows, and `configEncrypted` only exists once an
            // external provider has been configured.
            for (const name of ['configEncrypted', 'outputsEncrypted']) {
                expect(column(name)?.options.type).toBe('text');
                expect(column(name)?.options.nullable).toBe(true);
            }
        });

        it('stores statusDetail / declared / resourceRefs as simple-json', () => {
            for (const name of ['statusDetail', 'declared', 'resourceRefs']) {
                expect(column(name)?.options.type).toBe('simple-json');
            }
            // `declared` is the App spec block the row was reconciled from: a row
            // without it could not be diffed against the next spec.
            expect(column('declared')?.options.nullable).not.toBe(true);
        });
    });

    describe('defaults a fresh row starts with (plan §3.2:212,217,219)', () => {
        it('starts with no attempts, no written outputs version and still in the spec', () => {
            expect(column('attempts')?.options.type).toBe('int');
            expect(column('attempts')?.options.default).toBe(0);

            expect(column('outputsVersion')?.options.type).toBe('int');
            expect(column('outputsVersion')?.options.default).toBe(0);

            expect(column('inSpec')?.options.type).toBe('boolean');
            expect(column('inSpec')?.options.default).toBe(true);
        });

        it('leaves backupState with no default — the provider’s first report sets it', () => {
            expect(column('backupState')?.options.default).toBeUndefined();
        });
    });

    describe('every stamp is a portable epoch-millis column', () => {
        it.each(TIMESTAMP_COLUMNS)(
            '%s stores a bigint through the epoch-ms transformer',
            (name) => {
                const options = column(name)?.options;

                expect(options?.type).toBe('bigint');
                expect(options?.nullable).toBe(true);
                expect(typeof options?.transformer).toBe('object');
            },
        );

        it('round-trips the lease stamp, which the claim compares as a number', () => {
            const transformer = column('provisionLeaseUntil')?.options.transformer as {
                to: (value?: Date) => unknown;
                from: (value?: unknown) => unknown;
            };
            const until = new Date('2026-09-17T10:00:00.000Z');

            expect(transformer.to(until)).toBe(until.getTime());
            expect((transformer.from(until.getTime()) as Date).getTime()).toBe(until.getTime());
            expect(transformer.to(undefined)).toBeNull();
        });

        it('carries createdAt / updatedAt as the two TypeORM date columns', () => {
            expect(column('createdAt')?.mode).toBe('createDate');
            expect(column('updatedAt')?.mode).toBe('updateDate');
        });
    });

    describe('indexes (plan §3.2:225-227)', () => {
        const indices = storage.indices.filter((entry) => entry.target === WorkAppDependency);

        it('declares exactly the two plain indexes the plan names', () => {
            expect(indices.map((entry) => entry.name).sort()).toEqual([
                'idx_work_app_dependencies_status',
                'idx_work_app_dependencies_work',
            ]);
        });

        it('indexes the per-Work read on workId', () => {
            const byWork = indices.find((entry) => entry.name === 'idx_work_app_dependencies_work');

            expect(byWork?.columns).toEqual(['workId']);
            expect(byWork?.unique).not.toBe(true);
        });

        it('indexes the refresh scan on (status, lastCheckedAt)', () => {
            const status = indices.find(
                (entry) => entry.name === 'idx_work_app_dependencies_status',
            );

            expect(status?.columns).toEqual(['status', 'lastCheckedAt']);
            expect(status?.unique).not.toBe(true);
        });

        it('declares NO unique index — the active one is partial and lives in the migration', () => {
            // A decorated `unique: true` would be synthesised non-partially by
            // `synchronize` on the SQLite lane and would then refuse the second
            // `kept` row of the same kind a released dependency leaves behind.
            expect(indices.some((entry) => entry.unique === true)).toBe(false);
        });
    });

    describe('the partial unique index lives in the migration (APW07-G12)', () => {
        it('is emitted as raw SQL, never as a decorator', () => {
            // plan §3.4:333-338, the `1791220000000-CreateWorkspaceBackups.ts:26-34`
            // convention: raw statements from a driver branch, where `WHERE`
            // clauses on indexes are expressible. The exact three statements are
            // pinned in `CreateAppEnvAndDependencies.spec.ts`.
            expect(MIGRATION_SOURCE).toContain('activeUniqueIndexStatements');
            expect(MIGRATION_SOURCE).toContain('uq_work_app_dependencies_active');
        });

        it('keys the excluded statuses off APP_DEPENDENCY_INACTIVE_STATUSES, today', () => {
            // The migration spells the two statuses out — frozen history, so a
            // later widening of the contracts constant cannot rewrite a
            // migration that has already run — and this is where the two are
            // held together.
            expect([...APP_DEPENDENCY_INACTIVE_STATUSES]).toEqual(['kept', 'deleted']);
            expect(MIGRATION_SOURCE).toContain(
                `INACTIVE_STATUSES = ['${APP_DEPENDENCY_INACTIVE_STATUSES.join("', '")}']`,
            );
            expect(MIGRATION_SOURCE).toContain('APP_DEPENDENCY_INACTIVE_STATUSES');
        });

        it('has a Postgres branch that guards the partial index on the driver', () => {
            // The Postgres form is the plan's: a UNIQUE index over (workId, kind)
            // with the `WHERE … NOT IN (…)` predicate, created only for that
            // driver family.
            expect(MIGRATION_SOURCE).toContain(`driver === 'postgres'`);
            expect(MIGRATION_SOURCE).toContain(
                'ON "${table}" ("workId", "kind") WHERE "status" NOT IN (${inactive})',
            );
        });

        it('gives SQLite an equivalent unique expression index', () => {
            // SQLite has no generated-column form in this schema, so the
            // equivalent is a UNIQUE index whose third key part is NULL for the
            // inactive rows — and NULLs never collide in SQLite or MySQL.
            expect(MIGRATION_SOURCE).toContain(
                'CASE WHEN "status" NOT IN (${inactive}) THEN 1 ELSE NULL END',
            );
            expect(MIGRATION_SOURCE).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
        });

        it('gives MySQL/MariaDB a generated-column unique key', () => {
            expect(MIGRATION_SOURCE).toContain('GENERATED ALWAYS AS');
            expect(MIGRATION_SOURCE).toContain('ADD UNIQUE KEY');
            expect(MIGRATION_SOURCE).toContain(`driver === 'mysql'`);
        });
    });

    describe('relations and scope columns', () => {
        it('cascades on the Work, and holds no other relation', () => {
            expect(column('workId')?.options.type).toBe('uuid');
            expect(column('workId')?.options.nullable).not.toBe(true);

            const relations = storage.relations.filter(
                (entry) => entry.target === WorkAppDependency,
            );
            expect(relations).toHaveLength(1);
            expect(relations[0].propertyName).toBe('work');
            expect(relations[0].relationType).toBe('many-to-one');
            expect(relations[0].options.onDelete).toBe('CASCADE');
        });

        it('stamps tenantId / organizationId as plain columns with no relation', () => {
            for (const name of ['tenantId', 'organizationId']) {
                expect(column(name)?.options.type).toBe('uuid');
                expect(column(name)?.options.nullable).toBe(true);
            }
        });
    });

    describe('the closed sets come from @ever-works/contracts (T2)', () => {
        it('gives kind a width that holds every APP_DEPENDENCY_KINDS member', () => {
            const width = Number(column('kind')?.options.length ?? 0);

            for (const member of APP_DEPENDENCY_KINDS) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });

        it('gives deployTarget a width that holds every APP_DEPENDENCY_TARGETS member', () => {
            const width = Number(column('deployTarget')?.options.length ?? 0);

            for (const member of APP_DEPENDENCY_TARGETS) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
            expect(width).toBeGreaterThanOrEqual('ever-works-apps'.length);
        });

        it('gives status a width that holds every APP_DEPENDENCY_STATUSES member', () => {
            // `awaiting_config` is the longest member (15) — the state plan §4.9a
            // adds, which must not need a migration to fit.
            const width = Number(column('status')?.options.length ?? 0);

            for (const member of APP_DEPENDENCY_STATUSES) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
            expect(width).toBeGreaterThanOrEqual('awaiting_config'.length);
        });

        it('gives backupPolicy a width that holds every APP_DEPENDENCY_BACKUP_POLICIES member', () => {
            const width = Number(column('backupPolicy')?.options.length ?? 0);

            for (const member of APP_DEPENDENCY_BACKUP_POLICIES) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });

        it('gives backupState a width that holds every APP_DEPENDENCY_BACKUP_STATES member', () => {
            const width = Number(column('backupState')?.options.length ?? 0);

            for (const member of APP_DEPENDENCY_BACKUP_STATES) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
            expect(width).toBeGreaterThanOrEqual('not_configured'.length);
        });
    });
});
