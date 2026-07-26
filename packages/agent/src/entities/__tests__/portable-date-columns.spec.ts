import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * GUARD: no entity may declare a raw `type: 'timestamp'` column.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * `timestamp` is a Postgres type. The e2e suite and CI run TypeORM against
 * better-sqlite3, which has no such type, so a raw timestamp column makes
 * TypeORM's metadata validation throw at DataSource init:
 *
 *     DataTypeNotSupportedError: Data type "timestamp" in
 *     "IngestedEvent.occurredAt" is not supported by "better-sqlite3" database.
 *
 * That happens BEFORE the app finishes booting, so the API never starts. Since
 * the API is the whole e2e environment, EVERY Playwright shard then dies in
 * global-setup and exits 1 with no test output and no failing test name — a
 * maximally confusing red that looks like infrastructure.
 *
 * This has now landed SIX times (agent, mission, organization, user,
 * work-budget-alert-state, agent-run, and the Wave 6 ingest/meeting/fleet
 * entities all hit it). Comments in those files were not enough to stop it, so
 * this test enforces it mechanically.
 *
 * THE FIX when this test fails: use `@PortableDateColumn()` from
 * `../_types` (it maps to the `Date` type, which every driver supports).
 * `@PortableDateColumn({ nullable: true })` for a nullable column.
 */
describe('entities — portable date columns', () => {
    const entitiesDir = join(__dirname, '..');

    /** Every `*.entity.ts` source file (not the compiled output, not tests). */
    const entityFiles = readdirSync(entitiesDir).filter((f) => f.endsWith('.entity.ts'));

    it('finds entity files to check (guards against a silently-empty sweep)', () => {
        expect(entityFiles.length).toBeGreaterThan(10);
    });

    it.each(entityFiles)('%s declares no raw sqlite-incompatible date column', (file) => {
        const source = readFileSync(join(entitiesDir, file), 'utf8');

        const offenders = source
            .split('\n')
            .map((line, i) => ({ line: line.trim(), no: i + 1 }))
            // Only real code — skip the explanatory comments that warn about this
            // very trap (several entities carry them).
            .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*'))
            .filter(({ line }) => /type:\s*['"](timestamp|timestamptz|datetime)['"]/.test(line));

        if (offenders.length > 0) {
            throw new Error(
                `${file} uses a driver-specific date type. better-sqlite3 (e2e/CI) has no ` +
                    `"timestamp" type, so this makes TypeORM throw DataTypeNotSupportedError ` +
                    `at DataSource init and the API cannot boot — every e2e shard then fails ` +
                    `with no test output.\n` +
                    `Use @PortableDateColumn() from '../_types' instead ` +
                    `(add { nullable: true } for a nullable column).\n` +
                    `Offending lines:\n` +
                    offenders.map((o) => `  ${o.no}: ${o.line}`).join('\n'),
            );
        }
        expect(offenders).toEqual([]);
    });
});
