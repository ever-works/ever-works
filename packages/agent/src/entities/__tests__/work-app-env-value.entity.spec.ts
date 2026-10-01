import { readFileSync } from 'fs';
import { join } from 'path';
import { getMetadataArgsStorage } from 'typeorm';
import { APP_ENV_KEYPAIR_TYPES, APP_ENV_STORED_ORIGINS } from '@ever-works/contracts';
import { WorkAppEnvValue } from '../work-app-env-value.entity';

/**
 * APW-07 T5 — the `WorkAppEnvValue` entity's shape, pinned against plan §3.1
 * (`plan.md:176-193`), the migration (T7) and the repository's select
 * discipline (T8) so the four cannot drift apart unnoticed.
 *
 * What matters here, in the order T5 states it:
 *
 *  - the **unique index** `uq_work_app_env_values_work_name (workId, name)`,
 *    which is what makes "one row per name per App Work" true at the database
 *    rather than only in the service that writes it;
 *  - **`valueEncrypted` NOT NULL** — a row without an envelope is a row whose
 *    value nobody can read (FR-5 keeps the plaintext out of the database
 *    entirely), so the plan does not allow one;
 *  - the **scope columns** `tenantId` / `organizationId`, declared as plain
 *    nullable uuids with no relation (the EW-654 cycle-avoidance rule that
 *    `WorkUpstreamState` and `WorkDeployment` record);
 *  - and — the assertion that keeps a stored secret out of a UI response —
 *    that the repository's `find` helpers carry an explicit `select` list and
 *    that `valueEncrypted` is not on it, with no `select: true` anywhere in
 *    the file.
 *
 * The closed set is read from `@ever-works/contracts` (APW-07 T1) rather than
 * re-listed: a column width that cannot hold its longest legal member is a
 * real defect, and it is asserted against here.
 */
describe('WorkAppEnvValue entity', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((column) => column.target === WorkAppEnvValue);
    const column = (name: string) => columns.find((entry) => entry.propertyName === name);
    const propertyNames = columns.map((entry) => entry.propertyName);

    /** The 15 columns of plan §3.1:180-190, verbatim and complete. */
    const PLAN_COLUMNS = [
        'id',
        'workId',
        'name',
        'origin',
        'valueEncrypted',
        'valueBytes',
        'version',
        'generatorFingerprint',
        'derivedFromName',
        'generatedAt',
        'setByUserId',
        'tenantId',
        'organizationId',
        'createdAt',
        'updatedAt',
    ];

    /** The columns the plan writes `NOT NULL`. */
    const NOT_NULL_COLUMNS = [
        'workId',
        'name',
        'origin',
        'valueEncrypted',
        'valueBytes',
        'version',
    ];

    /** The columns the plan writes `NULL`. */
    const NULLABLE_COLUMNS = [
        'generatorFingerprint',
        'derivedFromName',
        'generatedAt',
        'setByUserId',
        'tenantId',
        'organizationId',
    ];

    describe('table and columns (plan §3.1)', () => {
        it('maps to work_app_env_values', () => {
            const table = storage.tables.find((entry) => entry.target === WorkAppEnvValue);

            expect(table?.name).toBe('work_app_env_values');
        });

        it('declares exactly the 15 columns of plan §3.1, and nothing else', () => {
            // The count and the set are both pinned: a column added here without
            // the plan — and therefore without the migration — is a schema the
            // entity believes in and the database does not have.
            expect(columns).toHaveLength(15);
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

        it('keeps valueEncrypted NOT NULL — the envelope is the value (FR-5)', () => {
            // `enc::v1::` envelope text; nothing else holds the plaintext.
            expect(column('valueEncrypted')?.options.type).toBe('text');
            expect(column('valueEncrypted')?.options.nullable).not.toBe(true);
        });

        it('uses the plan’s widths for the name and fingerprint columns', () => {
            const widths: Array<[string, number]> = [
                ['name', 128],
                ['origin', 16],
                ['generatorFingerprint', 160],
                ['derivedFromName', 128],
            ];

            for (const [name, length] of widths) {
                expect(column(name)?.options.type).toBe('varchar');
                expect(column(name)?.options.length).toBe(length);
            }
        });

        it('gives origin a width that holds every stored origin of the contracts union', () => {
            const width = Number(column('origin')?.options.length ?? 0);

            for (const member of APP_ENV_STORED_ORIGINS) {
                expect(member.length).toBeLessThanOrEqual(width);
            }
            // `derived` is the longest member the keypair public-half rows carry.
            expect(width).toBeGreaterThanOrEqual('generated'.length);
        });

        it('gives generatorFingerprint room for the longest canonical generate block', () => {
            // plan §4.3:397 — `keypair:rsa-4096:base64url-raw:<passwordEnv>`, so
            // the width has to hold a keypair type, a format and an env name.
            const longest = `keypair:${APP_ENV_KEYPAIR_TYPES[3]}:base64url-raw:PASSWORD_ENV_NAME`;

            expect(longest.length).toBeLessThanOrEqual(
                Number(column('generatorFingerprint')?.options.length ?? 0),
            );
        });
    });

    describe('defaults a fresh row starts with (plan §3.1:185)', () => {
        it('starts at version 1 — the first stored value is not a change', () => {
            expect(column('version')?.options.type).toBe('int');
            expect(column('version')?.options.default).toBe(1);
        });

        it('leaves valueBytes with no default — it is always measured from the value', () => {
            expect(column('valueBytes')?.options.type).toBe('int');
            expect(column('valueBytes')?.options.default).toBeUndefined();
        });
    });

    describe('timestamps', () => {
        it('stores generatedAt as a portable epoch-millis column', () => {
            // The house rule for a Work-child timestamp: `bigint` through the
            // epoch-ms transformer, because better-sqlite3 (CI, the e2e stack and
            // the default local install) has no `timestamp` type.
            expect(column('generatedAt')?.options.type).toBe('bigint');
            expect(column('generatedAt')?.options.nullable).toBe(true);
            expect(typeof column('generatedAt')?.options.transformer).toBe('object');
        });

        it('round-trips a Date through generatedAt’s stored epoch', () => {
            const transformer = column('generatedAt')?.options.transformer as {
                to: (value?: Date) => unknown;
                from: (value?: unknown) => unknown;
            };
            const when = new Date('2026-09-17T09:30:00.000Z');

            expect(transformer.to(when)).toBe(when.getTime());
            expect((transformer.from(when.getTime()) as Date).getTime()).toBe(when.getTime());
            expect(transformer.to(undefined)).toBeNull();
        });

        it('carries createdAt / updatedAt as the two TypeORM date columns', () => {
            expect(column('createdAt')?.mode).toBe('createDate');
            expect(column('updatedAt')?.mode).toBe('updateDate');
        });
    });

    describe('indexes the migration also creates (plan §3.1:191-192)', () => {
        const indices = storage.indices.filter((entry) => entry.target === WorkAppEnvValue);

        it('declares exactly the two indexes the plan names', () => {
            expect(indices.map((entry) => entry.name).sort()).toEqual([
                'idx_work_app_env_values_work',
                'uq_work_app_env_values_work_name',
            ]);
        });

        it('makes (workId, name) unique, so one App Work holds one row per name', () => {
            const unique = indices.find(
                (entry) => entry.name === 'uq_work_app_env_values_work_name',
            );

            expect(unique?.columns).toEqual(['workId', 'name']);
            expect(unique?.unique).toBe(true);
        });

        it('indexes the per-Work read on workId', () => {
            const byWork = indices.find((entry) => entry.name === 'idx_work_app_env_values_work');

            expect(byWork?.columns).toEqual(['workId']);
            expect(byWork?.unique).not.toBe(true);
        });
    });

    describe('relations and scope columns', () => {
        it('cascades on the Work, because the row describes the Work and nothing else', () => {
            expect(column('workId')?.options.type).toBe('uuid');
            expect(column('workId')?.options.nullable).not.toBe(true);

            const relations = storage.relations.filter((entry) => entry.target === WorkAppEnvValue);
            expect(relations).toHaveLength(1);
            expect(relations[0].propertyName).toBe('work');
            expect(relations[0].relationType).toBe('many-to-one');
            expect(relations[0].options.onDelete).toBe('CASCADE');
        });

        it('stamps tenantId / organizationId as plain columns with no relation', () => {
            // Same reasoning as WorkDeployment (EW-654/EW-655): a relation here
            // would pull the Tenant/Organization graph into decorator evaluation
            // of the whole entity inventory.
            for (const name of ['tenantId', 'organizationId']) {
                expect(column(name)?.options.type).toBe('uuid');
                expect(column(name)?.options.nullable).toBe(true);
            }

            expect(
                storage.relations.filter((entry) => entry.target === WorkAppEnvValue),
            ).toHaveLength(1);
        });

        it('keeps setByUserId a bare uuid — a deleted user must not cascade a value away', () => {
            expect(column('setByUserId')?.options.type).toBe('uuid');
            expect(column('setByUserId')?.options.nullable).toBe(true);
            expect(
                storage.relations.some(
                    (entry) =>
                        entry.target === WorkAppEnvValue && entry.propertyName === 'setByUserId',
                ),
            ).toBe(false);
        });
    });

    describe('the repository never exposes the envelope by default (T8)', () => {
        const source = readFileSync(
            join(
                __dirname,
                '..',
                '..',
                'database',
                'repositories',
                'work-app-env-value.repository.ts',
            ),
            'utf8',
        );

        /** `select` lists that name the secret column, which no read path may do. */
        const exportsEnvelope = (body: string) => body.includes('valueEncrypted');

        /** The source of one method DECLARATION: its header line to the brace at 4 spaces. */
        function methodSource(name: string): string {
            const declaration = new RegExp(
                `^    (?:private |async |private async )?${name}\\s*\\(`,
                'm',
            ).exec(source);
            expect(declaration).not.toBeNull();
            const start = declaration?.index ?? -1;
            const end = source.indexOf('\n    }', start);
            expect(end).toBeGreaterThan(start);
            return source.slice(start, end);
        }

        const findHelpers = [...source.matchAll(/^    (?:async )?(find[A-Za-z0-9_]*)\s*\(/gm)].map(
            (match) => match[1],
        );

        it('declares the per-Work read the table performs', () => {
            expect(findHelpers).toContain('findByWork');
        });

        it('has no `select: true` anywhere — no read asks the ORM for every column', () => {
            expect(source).not.toMatch(/select:\s*true/);
        });

        it.each(['findByWork'])(
            '%s passes an explicit select list that does NOT name valueEncrypted',
            (name) => {
                const body = methodSource(name);

                expect(body).toMatch(/select:/);
                expect(exportsEnvelope(body)).toBe(false);
            },
        );

        it('reads the envelope only in a private, deliberately named helper', () => {
            // `insertIfAbsent` has to return the stored envelope — that is
            // ACC-07-02's "all callers read the same envelope" — so exactly one
            // read exists that does not select around it. It is private, it is
            // named for what it does, and no UI path can reach it.
            expect(source).toContain('private readStoredEnvelope(');
            const body = methodSource('readStoredEnvelope');

            expect(body).toContain('findOne');
            expect(body).not.toMatch(/select:/);
        });

        it('keeps the metadata select list free of the envelope and honest about its length', () => {
            const declaration = source.slice(
                source.indexOf('WORK_APP_ENV_VALUE_METADATA_COLUMNS = ['),
                source.indexOf(
                    '] as const',
                    source.indexOf('WORK_APP_ENV_VALUE_METADATA_COLUMNS = ['),
                ),
            );

            expect(declaration.length).toBeGreaterThan(0);
            expect(exportsEnvelope(declaration)).toBe(false);
            const entries = [...declaration.matchAll(/'([A-Za-z0-9_]+)'/g)].map(
                (match) => match[1],
            );
            // Every plan column except the envelope, and no invented one.
            expect(entries.sort()).toEqual(
                PLAN_COLUMNS.filter((name) => name !== 'valueEncrypted').sort(),
            );
        });
    });
});
