import { getMetadataArgsStorage } from 'typeorm';
import {
    APP_BUILD_BLOCKED_REASONS,
    APP_BUILD_CANCEL_REASONS,
    APP_BUILD_FAILURE_CLASSES,
    APP_BUILD_NOT_DEPLOYABLE_REASONS,
    APP_BUILD_RUNNER_CLASSES,
    APP_BUILD_SECRET_CHECK_RESULTS,
    APP_BUILD_STATUSES,
    APP_BUILD_SYNC_ORIGINS,
    APP_BUILD_TRIGGERS,
} from '@ever-works/contracts';
import { WorkBuild } from '../work-build.entity';

/**
 * APW-05 T4 — the `WorkBuild` entity's shape, pinned against the migration
 * (T5) and plan §3.1's column table so the three cannot drift apart unnoticed.
 *
 * Plan §3.1 (`plan.md:329-396`) is the normative column list: **54 columns**,
 * five named indexes and one `@ManyToOne(() => Work, { onDelete: 'CASCADE' })`.
 *
 * What matters here, in the order the task states it:
 *
 *  - the five **index names** the migration also creates, their columns and
 *    their uniqueness flags;
 *  - `uq_work_builds_provider_run` is a **plain** UNIQUE over
 *    `(buildPluginId, providerRunId, runAttempt)` with **no partial `WHERE`** —
 *    `APW05-G10` (`plan.md:375-379`): one DDL that is valid on Postgres, SQLite,
 *    MySQL and MariaDB, NULLs distinct on all four, and `upsert(conflictPaths)`
 *    without the Postgres-only `indexPredicate`;
 *  - both **scope columns** are present, as plain uuids with no relation;
 *  - the defaults a fresh row starts with (`runAttempt` 1, `digestConfirmed` /
 *    `deployable` false, `syncOrigin` `none`) and the deliberate ABSENCE of a
 *    default on the four columns the plan leaves to their writer;
 *  - every time column is a `TimestampColumn` (bigint + epoch-ms transformer),
 *    never a raw `Date`;
 *  - the closed sets are read from `@ever-works/contracts` rather than re-listed,
 *    so a column width that cannot hold its longest legal member is a failure.
 *
 * The `checksBillableMinutes` / `verifySecretNames` columns and the
 * `syncOrigin` / `syncFromSha` / `syncToSha` trio are called out by the task as
 * the ones APW-04 and APW-06 read (`APW04-G06`), so they are asserted
 * individually as well as through the full column set.
 */
describe('WorkBuild entity', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((column) => column.target === WorkBuild);
    const column = (name: string) => columns.find((entry) => entry.propertyName === name);
    const propertyNames = columns.map((entry) => entry.propertyName);
    const indices = storage.indices.filter((entry) => entry.target === WorkBuild);

    /** The 54 columns of plan §3.1:332-364, verbatim and complete. */
    const PLAN_COLUMNS = [
        'id',
        'workId',
        'number',
        'buildPluginId',
        'status',
        'trigger',
        'blockedReason',
        'blockedDetail',
        'cancelReason',
        'branch',
        'commitSha',
        'pullRequestNumber',
        'providerRunId',
        'runAttempt',
        'dispatchCorrelationId',
        'dispatchedAt',
        'appSpecHash',
        'specValidAtCommit',
        'buildInputsHash',
        'buildSecretNames',
        'secretsSyncedAt',
        'runnerLabel',
        'runnerClass',
        'imageRepository',
        'imageDigest',
        'imageTags',
        'digestConfirmed',
        'secretCheck',
        'deployable',
        'notDeployableReason',
        'failureClass',
        'failureDetail',
        'failureExcerpt',
        'verificationResult',
        'verifiesBuildId',
        'syncOrigin',
        'syncFromSha',
        'syncToSha',
        'logsUrl',
        'queuedAt',
        'startedAt',
        'completedAt',
        'lastObservedAt',
        'watchLeaseUntil',
        'durationSeconds',
        'billableMinutes',
        'checksBillableMinutes',
        'verifySecretNames',
        'usageEventId',
        'triggeredByUserId',
        'tenantId',
        'organizationId',
        'createdAt',
        'updatedAt',
    ];

    /** Every time column the plan gives a `timestamp NULL` — the seven of §3.1. */
    const TIMESTAMP_COLUMNS = [
        'dispatchedAt',
        'secretsSyncedAt',
        'queuedAt',
        'startedAt',
        'completedAt',
        'lastObservedAt',
        'watchLeaseUntil',
    ];

    /** The plan's widths for the ids, shas, URLs and reason columns. */
    const WIDTHS: Array<[string, number]> = [
        ['buildPluginId', 64],
        ['status', 16],
        ['trigger', 16],
        ['blockedReason', 40],
        ['cancelReason', 16],
        ['branch', 255],
        ['commitSha', 40],
        ['providerRunId', 64],
        ['appSpecHash', 64],
        ['buildInputsHash', 64],
        ['runnerLabel', 64],
        ['runnerClass', 24],
        ['imageRepository', 255],
        ['imageDigest', 71],
        ['secretCheck', 16],
        ['notDeployableReason', 40],
        ['failureClass', 32],
        ['syncOrigin', 24],
        ['syncFromSha', 40],
        ['syncToSha', 40],
        ['logsUrl', 512],
    ];

    describe('table and columns (plan §3.1)', () => {
        it('maps to work_builds', () => {
            const table = storage.tables.find((entry) => entry.target === WorkBuild);

            expect(table?.name).toBe('work_builds');
        });

        it('declares exactly the 54 columns of plan §3.1, and nothing else', () => {
            // The count and the set are both pinned: a column added here without
            // the plan (and therefore without the migration) is a schema the
            // entity believes in and the database does not have.
            expect(columns).toHaveLength(54);
            expect([...propertyNames].sort()).toEqual([...PLAN_COLUMNS].sort());
        });

        it('carries the identity of a Build NOT NULL', () => {
            // Without these five there is no row to render: the plugin, the
            // status, how it was triggered and what it built.
            for (const name of [
                'number',
                'buildPluginId',
                'status',
                'trigger',
                'branch',
                'commitSha',
            ]) {
                expect(column(name)?.options.nullable).not.toBe(true);
            }
        });

        it('uses the plan’s widths for every bounded varchar', () => {
            for (const [name, length] of WIDTHS) {
                expect(column(name)?.options.type).toBe('varchar');
                expect(column(name)?.options.length).toBe(length);
            }
        });

        it('leaves the completion columns nullable, so an unfinished Build is expressible', () => {
            for (const name of [
                'blockedReason',
                'blockedDetail',
                'cancelReason',
                'pullRequestNumber',
                'providerRunId',
                'dispatchCorrelationId',
                'dispatchedAt',
                'appSpecHash',
                'specValidAtCommit',
                'buildInputsHash',
                'buildSecretNames',
                'secretsSyncedAt',
                'runnerLabel',
                'runnerClass',
                'imageRepository',
                'imageDigest',
                'imageTags',
                'secretCheck',
                'notDeployableReason',
                'failureClass',
                'failureDetail',
                'failureExcerpt',
                'verificationResult',
                'verifiesBuildId',
                'syncFromSha',
                'syncToSha',
                'logsUrl',
                'queuedAt',
                'startedAt',
                'completedAt',
                'lastObservedAt',
                'watchLeaseUntil',
                'durationSeconds',
                'billableMinutes',
                'checksBillableMinutes',
                'verifySecretNames',
                'usageEventId',
                'triggeredByUserId',
                'tenantId',
                'organizationId',
            ]) {
                expect(column(name)?.options.nullable).toBe(true);
            }
        });
    });

    describe('defaults a fresh row starts with (plan §3.1:341-356)', () => {
        it('starts every Build on the first attempt, unconfirmed and undeployable', () => {
            expect(column('runAttempt')?.options.default).toBe(1);
            expect(column('digestConfirmed')?.options.default).toBe(false);
            expect(column('deployable')?.options.default).toBe(false);
        });

        it('starts syncOrigin at none — the APW-04 producer stamps upstreamSync itself', () => {
            expect(column('syncOrigin')?.options.default).toBe('none');
            expect(column('syncOrigin')?.options.nullable).not.toBe(true);
        });

        it('gives no default to the columns the writer must fill in', () => {
            // A `queued` default on `status` would let a row exist that no
            // intake path ever accepted; the same for the enqueue clock.
            for (const name of ['status', 'trigger', 'queuedAt', 'startedAt', 'completedAt']) {
                expect(column(name)?.options.default).toBeUndefined();
            }
        });
    });

    describe('every time column is a TimestampColumn (bigint epoch ms)', () => {
        it.each(TIMESTAMP_COLUMNS)(
            '%s stores a bigint through the epoch-ms transformer',
            (name) => {
                const options = column(name)?.options;

                expect(options?.type).toBe('bigint');
                expect(typeof options?.transformer).toBe('object');
            },
        );

        it('round-trips a Date through the stored epoch — the lease compares numbers', () => {
            const transformer = column('watchLeaseUntil')?.options.transformer as {
                to: (value?: Date) => unknown;
                from: (value?: unknown) => unknown;
            };
            const when = new Date('2026-03-01T06:00:00.000Z');

            expect(transformer.to(when)).toBe(when.getTime());
            expect((transformer.from(when.getTime()) as Date).getTime()).toBe(when.getTime());
            // A NULL column stays NULL in both directions: "nobody is watching".
            expect(transformer.to(undefined)).toBeNull();
            expect(transformer.from(null)).toBeNull();
        });

        it('carries createdAt / updatedAt as the two TypeORM date columns', () => {
            expect(column('createdAt')?.mode).toBe('createDate');
            expect(column('updatedAt')?.mode).toBe('updateDate');
        });
    });

    describe('the five indexes of plan §3.1:367-373', () => {
        it('declares exactly the five indexes the plan names', () => {
            expect(indices.map((entry) => entry.name).sort()).toEqual([
                'idx_work_builds_status_observed',
                'idx_work_builds_work_commit',
                'idx_work_builds_work_created',
                'uq_work_builds_provider_run',
                'uq_work_builds_work_number',
            ]);
        });

        it('makes (workId, number) unique, so a Build number never repeats', () => {
            const unique = indices.find((entry) => entry.name === 'uq_work_builds_work_number');

            expect(unique?.columns).toEqual(['workId', 'number']);
            expect(unique?.unique).toBe(true);
        });

        it('makes the run identity a PLAIN unique — no partial WHERE (APW05-G10)', () => {
            // The assertion this spec exists for. A `WHERE` clause compiles on
            // Postgres, is refused by MySQL/MariaDB, and would stop
            // `upsert(conflictPaths)` from working without the Postgres-only
            // `indexPredicate` (plan.md:375-379).
            const unique = indices.find((entry) => entry.name === 'uq_work_builds_provider_run');

            expect(unique?.columns).toEqual(['buildPluginId', 'providerRunId', 'runAttempt']);
            expect(unique?.unique).toBe(true);
            expect(unique?.where).toBeUndefined();
        });

        it('declares no partial index anywhere on the table', () => {
            // The general form of the rule above: nothing on this entity — not
            // just the run identity — carries a `WHERE` clause.
            expect(indices.filter((entry) => entry.where !== undefined)).toEqual([]);
        });

        it('indexes the Builds list, the commit lookup and the sweep', () => {
            const created = indices.find((entry) => entry.name === 'idx_work_builds_work_created');
            const commit = indices.find((entry) => entry.name === 'idx_work_builds_work_commit');
            const observed = indices.find(
                (entry) => entry.name === 'idx_work_builds_status_observed',
            );

            expect(created?.columns).toEqual(['workId', 'createdAt']);
            expect(commit?.columns).toEqual(['workId', 'commitSha']);
            expect(observed?.columns).toEqual(['status', 'lastObservedAt']);
            for (const index of [created, commit, observed]) {
                expect(index?.unique).not.toBe(true);
            }
        });
    });

    describe('relations and scope columns', () => {
        it('cascades on the Work, because a Build describes the Work and nothing else', () => {
            expect(column('workId')?.options.type).toBe('uuid');
            expect(column('workId')?.options.nullable).not.toBe(true);

            const relations = storage.relations.filter((entry) => entry.target === WorkBuild);
            expect(relations).toHaveLength(1);
            expect(relations[0].propertyName).toBe('work');
            expect(relations[0].relationType).toBe('many-to-one');
            expect(relations[0].options.onDelete).toBe('CASCADE');
        });

        it('stamps tenantId / organizationId as plain columns with no relation', () => {
            // Same reasoning as WorkDeployment (EW-654/EW-655): a relation here
            // would pull the Tenant/Organization graph into decorator evaluation
            // of the entity inventory, and the scope subscriber reads the plain
            // columns anyway.
            for (const name of ['tenantId', 'organizationId']) {
                expect(column(name)?.options.type).toBe('uuid');
                expect(column(name)?.options.nullable).toBe(true);
            }

            expect(storage.relations.filter((entry) => entry.target === WorkBuild)).toHaveLength(1);
        });

        it('keeps the usage receipt, the triggerer and the verified Build as bare uuids', () => {
            // `plan.md:362` says the receipt carries no FK; the other two follow
            // the same rule, and `workId` is the ONLY relation on this entity.
            for (const name of ['usageEventId', 'triggeredByUserId', 'verifiesBuildId']) {
                expect(column(name)?.options.type).toBe('uuid');
                expect(column(name)?.options.nullable).toBe(true);
            }

            const relationProperties = storage.relations
                .filter((entry) => entry.target === WorkBuild)
                .map((entry) => entry.propertyName);
            expect(relationProperties).toEqual(['work']);
        });
    });

    describe('the columns APW-04 and APW-06 read (APW04-G06)', () => {
        it('carries the sync origin and its range', () => {
            expect(column('syncOrigin')?.options.type).toBe('varchar');
            expect(column('syncOrigin')?.options.length).toBe(24);
            expect(column('syncFromSha')?.options.length).toBe(40);
            expect(column('syncToSha')?.options.length).toBe(40);
        });

        it('carries checksBillableMinutes as a nullable int, so it is part of billableMinutes', () => {
            expect(column('checksBillableMinutes')?.options.type).toBe('int');
            expect(column('checksBillableMinutes')?.options.nullable).toBe(true);
            expect(column('billableMinutes')?.options.type).toBe('int');
        });

        it('carries verifySecretNames as a simple-json list of names', () => {
            expect(column('verifySecretNames')?.options.type).toBe('simple-json');
            expect(column('verifySecretNames')?.options.nullable).toBe(true);
        });
    });

    describe('the JSON columns', () => {
        it('stores every list and bag as simple-json, nullable', () => {
            for (const name of [
                'blockedDetail',
                'buildSecretNames',
                'imageTags',
                'failureDetail',
                'failureExcerpt',
                'verificationResult',
                'verifySecretNames',
            ]) {
                expect(column(name)?.options.type).toBe('simple-json');
                expect(column(name)?.options.nullable).toBe(true);
            }
        });
    });

    describe('the closed sets come from @ever-works/contracts', () => {
        it('gives status a width that holds every APP_BUILD_STATUSES member', () => {
            const width = Number(column('status')?.options.length ?? 0);

            for (const member of APP_BUILD_STATUSES) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });

        it('gives trigger a width that holds every APP_BUILD_TRIGGERS member', () => {
            const width = Number(column('trigger')?.options.length ?? 0);

            for (const member of APP_BUILD_TRIGGERS) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });

        it('gives cancelReason a width that holds every APP_BUILD_CANCEL_REASONS member', () => {
            const width = Number(column('cancelReason')?.options.length ?? 0);

            for (const member of APP_BUILD_CANCEL_REASONS) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });

        it('gives secretCheck a width that holds every APP_BUILD_SECRET_CHECK_RESULTS member', () => {
            const width = Number(column('secretCheck')?.options.length ?? 0);

            for (const member of APP_BUILD_SECRET_CHECK_RESULTS) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });

        it('gives runnerClass a width that holds every APP_BUILD_RUNNER_CLASSES member', () => {
            const width = Number(column('runnerClass')?.options.length ?? 0);

            for (const member of APP_BUILD_RUNNER_CLASSES) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });

        it('gives syncOrigin a width that holds every APP_BUILD_SYNC_ORIGINS member', () => {
            const width = Number(column('syncOrigin')?.options.length ?? 0);

            for (const member of APP_BUILD_SYNC_ORIGINS) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
            expect(column('syncOrigin')?.options.default).toBe(APP_BUILD_SYNC_ORIGINS[0]);
        });

        it('gives blockedReason a width that holds every APP_BUILD_BLOCKED_REASONS member', () => {
            const width = Number(column('blockedReason')?.options.length ?? 0);

            for (const member of APP_BUILD_BLOCKED_REASONS) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });

        it('gives notDeployableReason a width that holds every member of its set', () => {
            const width = Number(column('notDeployableReason')?.options.length ?? 0);

            for (const member of APP_BUILD_NOT_DEPLOYABLE_REASONS) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });

        it('gives failureClass a width that holds every APP_BUILD_FAILURE_CLASSES member', () => {
            const width = Number(column('failureClass')?.options.length ?? 0);

            for (const member of APP_BUILD_FAILURE_CLASSES) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });
    });
});
