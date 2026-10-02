import { readdirSync } from 'fs';
import { join } from 'path';
import type { DataSource } from 'typeorm';
import { validateStatsReportBody } from '@ever-works/agent/ever-instance';
import { CONTRACT_DIR, contractBytes, contractJson, type ExpectedRecord } from './contract-files';
import { createHarness } from './fixtures/harness';
import { createStatsDataSource, seedOneUserInstance } from './fixtures/works-seed';

/**
 * Every string in a report sits at an allow-listed path and matches that
 * path's form; there is no other string anywhere. And every invalid fixture
 * the SDK publishes is refused, at the path its `expected.json` names.
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

/** Every string value with its JSON pointer that is NOT allow-listed or does not match its form. */
function strayStrings(value: unknown, path = ''): string[] {
    if (typeof value === 'string') {
        const rule = STRING_PATHS.find(([pathPattern]) => pathPattern.test(path));
        return rule && rule[1].test(value) && value.length <= 64 ? [] : [path];
    }
    if (Array.isArray(value))
        return value.flatMap((item, index) => strayStrings(item, `${path}/${index}`));
    if (value && typeof value === 'object') {
        return Object.entries(value).flatMap(([key, item]) => [
            // A key is a string too: it must be a plain schema identifier or a currency code.
            ...(/^[a-z][a-z0-9_]{0,40}$|^[A-Z]{3}$/.test(key) ? [] : [`${path}/${key} (key)`]),
            ...strayStrings(item, `${path}/${key}`),
        ]);
    }
    return [];
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
    const invalid = readdirSync(join(CONTRACT_DIR, 'fixtures', 'stats', 'invalid')).sort();

    it('covers every invalid fixture the SDK publishes', () => {
        expect(invalid.length).toBeGreaterThanOrEqual(12);
        for (const name of invalid) expect(expected.fixtures[`invalid/${name}`]).toBeDefined();
    });

    it.each(invalid)('refuses invalid/%s at the published path', (name) => {
        const outcome = expected.fixtures[`invalid/${name}`];
        const result = validateStatsReportBody(
            contractBytes(join('fixtures', 'stats', 'invalid', name)),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.errors[0].path).toBe(outcome.path ?? '');
    });

    it.each(['gauzy', 'teams', 'works', 'rec', 'traduora'])('accepts valid/%s.json', (product) => {
        expect(
            validateStatsReportBody(
                contractBytes(join('fixtures', 'stats', 'valid', `${product}.json`)),
            ),
        ).toEqual({
            ok: true,
        });
    });
});
