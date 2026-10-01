import { getMetadataArgsStorage } from 'typeorm';
import { WorkAppSpecState } from '../work-app-spec-state.entity';
import { Work } from '../work.entity';

/**
 * APW-03 T9 — the entity's shape, pinned against plan §3.1 and against the
 * migration T10 creates, so the three cannot drift apart unnoticed.
 *
 * Plan §3.1 (`plan.md:397-452`) is the normative column list and §3.1:451-452
 * the three index names; `work-app-spec.dto.ts` in `@ever-works/contracts`
 * mirrors the same table for the API. The assertions below are the four things
 * T9's own "Test" line names — **index names, scope columns, portable dates** —
 * plus the column inventory, because a column added to the entity and not to
 * the migration (or the reverse) is exactly the drift this file exists to catch.
 *
 * Everything here is metadata-level: `getMetadataArgsStorage()` needs no
 * database, so this spec runs in milliseconds and cannot be defeated by a
 * driver quirk. The row-level behaviour — a fresh row's defaults, the FK
 * cascade, the unique index — is asserted against a real schema in
 * `apps/api/src/migrations/__tests__/CreateWorkAppSpecStates.spec.ts`.
 */
describe('WorkAppSpecState entity', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((entry) => entry.target === WorkAppSpecState);
    const column = (name: string) => columns.find((entry) => entry.propertyName === name);
    const indices = storage.indices.filter((entry) => entry.target === WorkAppSpecState);

    it('maps to work_app_spec_states', () => {
        const table = storage.tables.find((entry) => entry.target === WorkAppSpecState);
        expect(table?.name).toBe('work_app_spec_states');
    });

    it('declares every column of plan §3.1:403-449 and nothing else', () => {
        // The pinned list IS the plan's table, one row per line. A column added
        // without a plan row, or a plan row without a column, fails here.
        expect(columns.map((entry) => entry.propertyName).sort()).toEqual(
            [
                'attestation',
                'blueprintApplyError',
                'blueprintApplyRef',
                'blueprintApplyStatus',
                'blueprintId',
                'blueprintLatestVersion',
                'blueprintMatchSource',
                'blueprintMatchedAt',
                'blueprintRepo',
                'blueprintSha',
                'blueprintUpgradeDismissedVersion',
                'blueprintUpgradePr',
                'blueprintVersion',
                'createdAt',
                'dispatchedAt',
                'displayName',
                'effectiveAt',
                'effectiveCommitSha',
                'effectiveSpec',
                'effectiveSpecHash',
                'errorCount',
                'evaluatedSeq',
                'headCommitSha',
                'headSpecHash',
                'id',
                'issues',
                'issuesTruncated',
                'lastEvaluatedAt',
                'lastEvaluationError',
                'lastEvaluationTrigger',
                'licenseClass',
                'licenseCommitSha',
                'licenseEvaluatedAt',
                'licenseEvaluatedSeq',
                'licenseEvidence',
                'licenseMixed',
                'licenseObligations',
                'licenseRegistryHash',
                'licenseRegistrySource',
                'licenseRequestedSeq',
                'licenseScanIncomplete',
                'licenseSource',
                'licenseSpdx',
                'organizationId',
                'protectedPaths',
                'requestedSeq',
                'sourceOfferRequired',
                'startedSeq',
                'tenantId',
                'trackedBranch',
                'trademarkNotice',
                'updatedAt',
                'validationStatus',
                'warningCount',
                'workId',
            ].sort(),
        );
        expect(columns).toHaveLength(55);
    });

    describe('the three indexes of plan §3.1:451-452', () => {
        it('declares exactly three, under the names the migration creates', () => {
            expect(indices.map((entry) => entry.name).sort()).toEqual([
                'idx_work_app_spec_states_blueprint',
                'idx_work_app_spec_states_registry',
                'uq_work_app_spec_states_work',
            ]);
        });

        it('makes one App Work hold exactly one state row', () => {
            const unique = indices.find((entry) => entry.name === 'uq_work_app_spec_states_work');

            expect(unique?.unique).toBe(true);
            expect(unique?.columns).toEqual(['workId']);
        });

        it('indexes the Blueprint column pair the catalog refresh scans (plan §6.4:681)', () => {
            const blueprint = indices.find(
                (entry) => entry.name === 'idx_work_app_spec_states_blueprint',
            );

            expect(blueprint?.unique).not.toBe(true);
            expect(blueprint?.columns).toEqual(['blueprintId', 'blueprintVersion']);
        });

        it('indexes the registry hash the re-classification fan-out scans (plan §6.4:682)', () => {
            const registry = indices.find(
                (entry) => entry.name === 'idx_work_app_spec_states_registry',
            );

            expect(registry?.unique).not.toBe(true);
            expect(registry?.columns).toEqual(['licenseRegistryHash']);
        });
    });

    describe('scope columns (EW-655 Tier A)', () => {
        it('carries both scope stamps as nullable uuids', () => {
            for (const name of ['tenantId', 'organizationId']) {
                expect(column(name)?.options.type).toBe('uuid');
                expect(column(name)?.options.nullable).toBe(true);
            }
        });

        it('declares no relation for either scope column', () => {
            // A relation here drags the Tenant/Organization graph into
            // decorator evaluation and re-creates the import cycle that bit
            // Phase 2 — `skill-tag.entity.ts:52-53` and
            // `work-upstream-state.entity.ts:59-67` carry the same note.
            const relations = storage.relations.filter(
                (entry) => entry.target === WorkAppSpecState,
            );

            expect(relations).toHaveLength(1);
            expect(relations[0].propertyName).toBe('work');
            expect(relations[0].relationType).toBe('many-to-one');
        });

        it('cascades the state away with the App Work, and anchors it NOT NULL', () => {
            expect(column('workId')?.options.type).toBe('uuid');
            expect(column('workId')?.options.nullable).not.toBe(true);

            const [relation] = storage.relations.filter(
                (entry) => entry.target === WorkAppSpecState && entry.propertyName === 'work',
            );
            // `@ManyToOne(() => Work)` stores the thunk verbatim
            // (`ManyToOne.js`: `type: typeFunctionOrTarget`); a class target
            // stores the class itself. Resolve either, so the assertion is
            // about the target rather than about which spelling was used.
            const target = relation?.type as unknown;
            const resolved =
                typeof target === 'function' &&
                (target as { prototype?: unknown }).prototype === undefined
                    ? (target as () => unknown)()
                    : target;

            expect(resolved).toBe(Work);
            expect(relation?.options.onDelete).toBe('CASCADE');
        });
    });

    describe('portable dates', () => {
        // A raw `type: 'timestamp'` passes Postgres and kills better-sqlite3 —
        // the default DATABASE_TYPE, the CI driver and the e2e stack — at BOOT,
        // in TypeORM's metadata validation, taking the whole API down. The
        // reflected `Date` lets TypeORM pick each dialect's own spelling, and
        // plan §3.1:399-401 mandates `PortableDateColumn` for exactly this.
        const dateColumns = [
            'blueprintMatchedAt',
            'dispatchedAt',
            'effectiveAt',
            'lastEvaluatedAt',
            'licenseEvaluatedAt',
        ];

        it.each(dateColumns)('%s is a reflected Date, never a driver spelling', (name) => {
            expect(column(name)?.options.type).toBe(Date);
            expect(column(name)?.options.nullable).toBe(true);
        });

        it('declares no driver-specific date or time spelling anywhere', () => {
            const declared = columns
                .map((entry) => String(entry.options.type ?? entry.mode ?? ''))
                .map((type) => type.toLowerCase());

            for (const banned of [
                'timestamp',
                'timestamptz',
                'datetime',
                'datetime2',
                'date',
                'time',
                'timetz',
            ]) {
                expect(declared).not.toContain(banned);
            }
        });
    });

    describe('the coalescing columns', () => {
        it('starts all five sequences at zero', () => {
            for (const name of [
                'requestedSeq',
                'startedSeq',
                'evaluatedSeq',
                'licenseRequestedSeq',
                'licenseEvaluatedSeq',
            ]) {
                expect(column(name)?.options.type).toBe('bigint');
                expect(column(name)?.options.default).toBe(0);
                expect(column(name)?.options.nullable).not.toBe(true);
            }
        });

        it('leaves dispatchedAt unset, so a fresh row is not inside the coalescing window', () => {
            expect(column('dispatchedAt')?.options.default).toBeUndefined();
        });
    });

    describe('a fresh row reports honestly', () => {
        it('starts validationStatus missing — the row exists before anything was read', () => {
            expect(column('validationStatus')?.options.type).toBe('varchar');
            expect(column('validationStatus')?.options.length).toBe(24);
            expect(column('validationStatus')?.options.default).toBe('missing');
        });

        it('starts every counter at zero and every boolean false', () => {
            for (const name of ['errorCount', 'warningCount']) {
                expect(column(name)?.options.type).toBe('int');
                expect(column(name)?.options.default).toBe(0);
            }
            for (const name of [
                'issuesTruncated',
                'licenseMixed',
                'licenseScanIncomplete',
                'sourceOfferRequired',
            ]) {
                expect(column(name)?.options.type).toBe('boolean');
                expect(column(name)?.options.default).toBe(false);
            }
        });

        it('carries createdAt and updatedAt as the framework writes them', () => {
            expect(columns.find((entry) => entry.propertyName === 'createdAt')?.mode).toBe(
                'createDate',
            );
            expect(columns.find((entry) => entry.propertyName === 'updatedAt')?.mode).toBe(
                'updateDate',
            );
        });
    });

    describe('the widths and nullability plan §3.1 fixes', () => {
        it.each([
            ['trackedBranch', 255, false],
            ['headCommitSha', 40, true],
            ['effectiveCommitSha', 40, true],
            ['headSpecHash', 64, true],
            ['effectiveSpecHash', 64, true],
            ['lastEvaluationTrigger', 24, true],
            ['lastEvaluationError', 64, true],
            ['blueprintId', 64, true],
            ['blueprintVersion', 32, true],
            ['blueprintRepo', 128, true],
            ['blueprintSha', 40, true],
            ['blueprintMatchSource', 16, true],
            ['blueprintApplyStatus', 16, true],
            ['blueprintApplyError', 64, true],
            ['blueprintLatestVersion', 32, true],
            ['blueprintUpgradeDismissedVersion', 32, true],
            ['licenseSpdx', 200, true],
            ['licenseClass', 8, true],
            ['licenseSource', 16, true],
            ['licenseCommitSha', 40, true],
            ['licenseRegistryHash', 64, true],
            ['licenseRegistrySource', 16, true],
            ['displayName', 80, true],
            ['trademarkNotice', 500, true],
        ])('%s is varchar(%i), nullable %s', (name, length, nullable) => {
            expect(column(name)?.options.type).toBe('varchar');
            expect(column(name)?.options.length).toBe(length);
            expect(Boolean(column(name)?.options.nullable)).toBe(nullable);
        });

        it.each([
            'issues',
            'effectiveSpec',
            'blueprintApplyRef',
            'blueprintUpgradePr',
            'licenseEvidence',
            'licenseObligations',
            'attestation',
            'protectedPaths',
        ])('%s is a nullable simple-json column', (name) => {
            expect(column(name)?.options.type).toBe('simple-json');
            expect(column(name)?.options.nullable).toBe(true);
        });
    });

    it('carries the Blueprint-matched guard column the once-only Activity row reads', () => {
        // Plan §2.5 step 0, FR-82: `app.blueprint.matched` is recorded exactly
        // once per (workId, blueprintId, blueprintVersion), and this column is
        // the guard. Without it a re-dispatch records a second Activity row.
        expect(column('blueprintMatchedAt')).toBeDefined();
        expect(column('blueprintMatchedAt')?.options.type).toBe(Date);
        expect(column('blueprintMatchedAt')?.options.nullable).toBe(true);
    });
});
