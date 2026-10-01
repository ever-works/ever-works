import { getMetadataArgsStorage } from 'typeorm';
import { APP_BUILD_WEBHOOK_STATES, APP_BUILD_WORKFLOW_STATES } from '@ever-works/contracts';
import { WorkBuildPreparation } from '../work-build-preparation.entity';

/**
 * APW-05 T4 — the `WorkBuildPreparation` entity's shape, pinned against the
 * migration (T5) and plan §3.1b's column table.
 *
 * Plan §3.1b (`plan.md:398-425`) is the normative column list: **22 columns**,
 * the one unique index `uq_work_build_preparations_work` on `(workId)`, and one
 * `@ManyToOne(() => Work, { onDelete: 'CASCADE' })`.
 *
 * What matters here, in the order the task states it:
 *
 *  - the unique `workId` index, with `unique: true` and no partial clause —
 *    one preparation row per App Work is the whole point of the table;
 *  - the `webhookState` / `workflowState` **defaults** (`none`, and `none`),
 *    read back off the contracts' own unions rather than re-spelled here;
 *  - both **scope columns**, present as plain uuids with no relation;
 *  - `prepareSeq` starting at 0 — the coalescing marker of §7.2;
 *  - every time column is a `TimestampColumn` (bigint + epoch-ms transformer).
 *
 * `APW05-G03` is the other half of the contract and is asserted here too, at
 * the level an entity spec can: the class carries no route-shaped member and
 * the three columns the deliverable reads (`buildInputsHash`,
 * `buildSecretNames`, `secretsSyncedAt`) exist and are nullable, so a Work with
 * no completed sync is expressible as NULL rather than as a fabricated empty
 * hash.
 */
describe('WorkBuildPreparation entity', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((column) => column.target === WorkBuildPreparation);
    const column = (name: string) => columns.find((entry) => entry.propertyName === name);
    const propertyNames = columns.map((entry) => entry.propertyName);
    const indices = storage.indices.filter((entry) => entry.target === WorkBuildPreparation);

    /** The 22 columns of plan §3.1b:404-420, verbatim and complete. */
    const PLAN_COLUMNS = [
        'id',
        'workId',
        'buildPluginId',
        'buildInputsHash',
        'secretsSyncedAt',
        'buildSecretNames',
        'workflowSha256',
        'workflowState',
        'workflowPullRequestNumber',
        'workflowPullRequestUrl',
        'workflowWrittenAt',
        'webhookId',
        'webhookState',
        'runsEtag',
        'runsCheckedAt',
        'repositoryBlock',
        'prepareSeq',
        'lastPreparedAt',
        'tenantId',
        'organizationId',
        'createdAt',
        'updatedAt',
    ];

    /** The four time columns of §3.1b. */
    const TIMESTAMP_COLUMNS = [
        'secretsSyncedAt',
        'workflowWrittenAt',
        'runsCheckedAt',
        'lastPreparedAt',
    ];

    describe('table and columns (plan §3.1b)', () => {
        it('maps to work_build_preparations', () => {
            const table = storage.tables.find((entry) => entry.target === WorkBuildPreparation);

            expect(table?.name).toBe('work_build_preparations');
        });

        it('declares exactly the 22 columns of plan §3.1b, and nothing else', () => {
            expect(columns).toHaveLength(22);
            expect([...propertyNames].sort()).toEqual([...PLAN_COLUMNS].sort());
        });

        it('requires the plugin and the two state columns, whose defaults are below', () => {
            for (const name of ['buildPluginId', 'workflowState', 'webhookState']) {
                expect(column(name)?.options.nullable).not.toBe(true);
            }
        });

        it('uses the plan’s widths for the hashes, ids and the ETag', () => {
            const widths: Array<[string, number]> = [
                ['buildPluginId', 64],
                ['buildInputsHash', 64],
                ['workflowSha256', 64],
                ['workflowState', 24],
                ['workflowPullRequestUrl', 512],
                ['webhookId', 64],
                ['webhookState', 24],
                ['runsEtag', 128],
            ];

            for (const [name, length] of widths) {
                expect(column(name)?.options.type).toBe('varchar');
                expect(column(name)?.options.length).toBe(length);
            }
        });

        it('leaves every derived-but-not-yet-known column nullable', () => {
            for (const name of [
                'buildInputsHash',
                'secretsSyncedAt',
                'buildSecretNames',
                'workflowSha256',
                'workflowPullRequestNumber',
                'workflowPullRequestUrl',
                'workflowWrittenAt',
                'webhookId',
                'runsEtag',
                'runsCheckedAt',
                'repositoryBlock',
                'lastPreparedAt',
                'tenantId',
                'organizationId',
            ]) {
                expect(column(name)?.options.nullable).toBe(true);
            }
        });
    });

    describe('defaults a fresh row starts with (plan §3.1b:411-418)', () => {
        it('starts with no workflow and no webhook', () => {
            expect(column('workflowState')?.options.default).toBe('none');
            expect(column('webhookState')?.options.default).toBe('none');
            expect(column('workflowState')?.options.default).toBe(APP_BUILD_WORKFLOW_STATES[0]);
            expect(column('webhookState')?.options.default).toBe(APP_BUILD_WEBHOOK_STATES[0]);
        });

        it('starts prepareSeq at 0 — the coalescing marker has not moved yet', () => {
            expect(column('prepareSeq')?.options.type).toBe('int');
            expect(column('prepareSeq')?.options.default).toBe(0);
            expect(column('prepareSeq')?.options.nullable).not.toBe(true);
        });

        it('gives no default to the four columns a prepare writes', () => {
            // NULL on any of these means "no prepare has completed yet", which
            // is a fact §5.1's staleInputs clause and §7.4a's discovery floor
            // both depend on — a default would erase it.
            for (const name of [
                'buildInputsHash',
                'secretsSyncedAt',
                'workflowSha256',
                'workflowWrittenAt',
                'runsCheckedAt',
                'lastPreparedAt',
            ]) {
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

        it('round-trips a Date through the stored epoch — discovery orders by runsCheckedAt', () => {
            const transformer = column('runsCheckedAt')?.options.transformer as {
                to: (value?: Date) => unknown;
                from: (value?: unknown) => unknown;
            };
            const when = new Date('2026-03-01T06:00:00.000Z');

            expect(transformer.to(when)).toBe(when.getTime());
            expect((transformer.from(when.getTime()) as Date).getTime()).toBe(when.getTime());
            // NULL stays NULL: "never checked" is not 1970.
            expect(transformer.to(undefined)).toBeNull();
            expect(transformer.from(null)).toBeNull();
        });

        it('carries createdAt / updatedAt as the two TypeORM date columns', () => {
            expect(column('createdAt')?.mode).toBe('createDate');
            expect(column('updatedAt')?.mode).toBe('updateDate');
        });
    });

    describe('the unique workId index (plan §3.1b:405)', () => {
        it('declares exactly the one index the plan names', () => {
            expect(indices.map((entry) => entry.name)).toEqual(['uq_work_build_preparations_work']);
        });

        it('makes workId unique, so one App Work has one preparation row', () => {
            const unique = indices.find(
                (entry) => entry.name === 'uq_work_build_preparations_work',
            );

            expect(unique?.columns).toEqual(['workId']);
            expect(unique?.unique).toBe(true);
        });

        it('is a plain unique — no partial WHERE, so one DDL fits all four drivers', () => {
            const unique = indices.find(
                (entry) => entry.name === 'uq_work_build_preparations_work',
            );

            expect(unique?.where).toBeUndefined();
            // The workId column itself is NOT NULL, so the unique index is
            // total: two rows for one Work cannot both exist.
            expect(column('workId')?.options.nullable).not.toBe(true);
        });
    });

    describe('relations and scope columns', () => {
        it('cascades on the Work, because the preparation describes the Work', () => {
            const relations = storage.relations.filter(
                (entry) => entry.target === WorkBuildPreparation,
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

            expect(
                storage.relations.filter((entry) => entry.target === WorkBuildPreparation),
            ).toHaveLength(1);
        });
    });

    describe('the closed sets come from @ever-works/contracts', () => {
        it('gives workflowState a width that holds every APP_BUILD_WORKFLOW_STATES member', () => {
            const width = Number(column('workflowState')?.options.length ?? 0);

            for (const member of APP_BUILD_WORKFLOW_STATES) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });

        it('gives webhookState a width that holds every APP_BUILD_WEBHOOK_STATES member', () => {
            const width = Number(column('webhookState')?.options.length ?? 0);

            for (const member of APP_BUILD_WEBHOOK_STATES) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
        });
    });

    describe('the JSON columns', () => {
        it('stores the secret-name list and the repository block as simple-json, nullable', () => {
            for (const name of ['buildSecretNames', 'repositoryBlock']) {
                expect(column(name)?.options.type).toBe('simple-json');
                expect(column(name)?.options.nullable).toBe(true);
            }
        });
    });

    describe('APW05-G03 — derived state, and the three columns the consumer stamps', () => {
        it('carries the three columns a push or pull-request Build copies, all nullable', () => {
            // §7.5 stamps a Build from this row IN the same transaction; a Work
            // with no preparation row must leave all three NULL, which the
            // deployable verdict reads as staleInputs.
            for (const name of ['buildInputsHash', 'buildSecretNames', 'secretsSyncedAt']) {
                expect(column(name)).toBeDefined();
                expect(column(name)?.options.nullable).toBe(true);
            }
        });

        it('exposes no column named like an API write of the preparation itself', () => {
            // No API route writes this table: the row is written only by
            // `app-build-prepare`. A `requestedBy`, `updatedBy` or `apiEtag`
            // column would be the first sign of a second writer.
            for (const forbidden of ['requestedBy', 'updatedBy', 'apiEtag', 'lastRequestedBy']) {
                expect(propertyNames).not.toContain(forbidden);
            }
        });
    });
});
