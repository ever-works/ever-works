import { readdirSync } from 'fs';
import { join } from 'path';
import type { DataSource } from 'typeorm';
import { validateStatsReportBytes, walkStrings } from '@ever-co/connect-sdk';
import {
    STATS_FIXTURES_DIR,
    contractBytes,
    contractJson,
    type ExpectedRecord,
} from './contract-files.helper-spec';
import { createHarness } from './fixtures/harness.helper-spec';
import { createStatsDataSource, seedOneUserInstance } from './fixtures/works-seed.helper-spec';

/**
 * Every string in a report sits at an allow-listed path and matches that
 * path's form; there is no other string anywhere (the strings are listed by
 * the SDK's `walkStrings`, keys included). And every invalid fixture the
 * contract publishes is refused by the SDK's checks with the platform's answer:
 * the status, the path and the code its `expected.json` names.
 */
const STRING_PATHS: ReadonlyArray<[RegExp, RegExp]> = [
    [/^\/schema$/, /^ever\.stats\.v1$/],
    [
        /^\/(report_id|instance_id)$/,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ],
    [/^\/sent_at$/, /^20[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/],
    [/^\/(module_version|version)$/, /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/],
    [/^\/product$/, /^(gauzy|teams|works|rec|traduora)$/],
    [/^\/instance_kind$/, /^(backend|frontend)$/],
    [/^\/serves\/\d$/, /^(gauzy|teams|works|rec|traduora)$/],
    [/^\/channel$/, /^(stable|rc|beta|dev|custom)$/],
    [
        /^\/install_source$/,
        /^(cloud|self-hosted|ever\.sh|works_app|desktop|partner:[a-z0-9-]{2,32})$/,
    ],
    [/^\/country$/, /^([A-Z]{2}|ZZ)$/],
    [/^\/period$/, /^20[0-9]{2}-(0[1-9]|1[0-2])$/],
];

/** Every string with its JSON pointer that is NOT allow-listed or does not match its form. */
function strayStrings(value: unknown): string[] {
    return walkStrings(value).flatMap(({ path, value: text, kind }) => {
        // A key is a string too: it must be a plain schema identifier or a currency code.
        if (kind === 'key') {
            return /^[a-z][a-z0-9_]{0,40}$|^[A-Z]{3}$/.test(text) ? [] : [`${path} (key)`];
        }
        const rule = STRING_PATHS.find(([pathPattern]) => pathPattern.test(path));
        return rule && rule[1].test(text) && text.length <= 64 ? [] : [path];
    });
}

describe('ever.stats.v1 — string walker', () => {
    let dataSource: DataSource;
    let report: Record<string, unknown>;

    beforeAll(async () => {
        dataSource = await createStatsDataSource();
        await seedOneUserInstance(dataSource, '2026-10');
        const { builder } = createHarness(dataSource, {
            env: { EVER_INSTALL_SOURCE: 'partner:acme-hosting', EVER_STATS_COUNTRY: 'FR' },
        });
        report = (await builder.build('2026-10', false, new Date('2026-10-15T08:00:00Z'))) as never;
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('finds every string of a built report at an allow-listed path, in its form', () => {
        expect(strayStrings(report)).toEqual([]);
        // Vacuity guard: the report does carry strings to check.
        expect(
            Object.values(report).filter((value) => typeof value === 'string').length,
        ).toBeGreaterThan(8);
    });

    it('control: a string anywhere else is caught', () => {
        expect(
            strayStrings({ ...report, counts: { ...(report.counts as object), users: 'Alice' } }),
        ).toEqual(['/counts/users']);
        expect(strayStrings({ ...report, country: 'alice@example.com' })).toEqual(['/country']);
        expect(strayStrings({ ...report, aggregates: { 'acme-internal': 1 } })).toEqual([
            '/aggregates/acme-internal (key)',
        ]);
    });

    const expected = contractJson<ExpectedRecord>(join('fixtures', 'stats', 'expected.json'));
    const invalid = readdirSync(join(STATS_FIXTURES_DIR, 'invalid')).sort();

    /** The bytes of one statistics fixture, as a plain `Uint8Array`. */
    const fixture = (name: string) =>
        new Uint8Array(contractBytes(join('fixtures', 'stats', ...name.split('/'))));

    it('covers every invalid fixture the contract publishes', () => {
        expect(invalid.length).toBeGreaterThanOrEqual(12);
        for (const name of invalid) expect(expected.fixtures[`invalid/${name}`]).toBeDefined();
    });

    it.each(invalid)('refuses invalid/%s with the published answer', (name) => {
        const outcome = expected.fixtures[`invalid/${name}`];
        const result = validateStatsReportBytes(fixture(`invalid/${name}`));
        expect(result.ok).toBe(false);
        // `in` narrows whatever the compiler's null checks (this app runs without them).
        const error = 'error' in result ? result.error : null;
        expect({
            status: error?.status,
            code: error?.code,
            path: error?.errors[0]?.path,
            error: error?.errors[0]?.code,
        }).toEqual({
            status: outcome.status,
            code: outcome.code,
            path: outcome.path ?? '',
            error: outcome.error,
        });
    });

    it.each(['gauzy', 'teams', 'works', 'rec', 'traduora'])('accepts valid/%s.json', (product) => {
        expect(validateStatsReportBytes(fixture(`valid/${product}.json`)).ok).toBe(true);
    });
});
