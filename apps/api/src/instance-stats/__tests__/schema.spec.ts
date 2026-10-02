import type { DataSource } from 'typeorm';
import {
    EVER_STATS_V1_SCHEMA,
    compileStrictStatsSchema,
    validateStatsReport,
} from '@ever-works/agent/ever-instance';
import { createHarness } from './fixtures/harness.helper-spec';
import { createStatsDataSource, seedOneUserInstance } from './fixtures/works-seed.helper-spec';

type Json = Record<string, unknown>;

/**
 * Every object level of the published schema is closed, and the builder's
 * output validates against it strictly.
 *
 * "Closed" means `additionalProperties: false`, or — for the currency maps,
 * the one place keys are not a fixed list — `additionalProperties` limited to
 * an integer schema AND `propertyNames` bound by a pattern AND
 * `maxProperties`. The meta-test walks every subschema; the control removes
 * one `additionalProperties: false` and shows both the meta-test and the
 * validator then let an unknown field through.
 */
function openObjects(schema: unknown, path = '#'): string[] {
    if (!schema || typeof schema !== 'object') return [];
    const node = schema as Json;
    const found: string[] = [];
    const isObject = node.type === 'object';
    if (isObject) {
        const closed = node.additionalProperties === false;
        const boundedMap =
            typeof node.additionalProperties === 'object' &&
            node.additionalProperties !== null &&
            typeof (node.propertyNames as Json | undefined)?.pattern === 'string' &&
            typeof node.maxProperties === 'number';
        if (!closed && !boundedMap) found.push(path);
    }
    for (const [key, value] of Object.entries(node)) {
        if (Array.isArray(value)) {
            value.forEach((item, index) =>
                found.push(...openObjects(item, `${path}/${key}/${index}`)),
            );
        } else if (value && typeof value === 'object') {
            found.push(...openObjects(value, `${path}/${key}`));
        }
    }
    return found;
}

describe('ever.stats.v1 — strict schema', () => {
    let dataSource: DataSource;
    let validReport: Json & { counts: Json };

    beforeAll(async () => {
        dataSource = await createStatsDataSource();
        await seedOneUserInstance(dataSource, '2026-10');
        const { builder } = createHarness(dataSource);
        validReport = (await builder.build(
            '2026-10',
            false,
            new Date('2026-10-15T08:00:00Z'),
        )) as unknown as Json & { counts: Json };
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('closes every object level (meta-test)', () => {
        expect(openObjects(EVER_STATS_V1_SCHEMA)).toEqual([]);
        // Vacuity guard: the walk did see the nested Works maps.
        expect(JSON.stringify(EVER_STATS_V1_SCHEMA)).toContain('works_by_kind');
    });

    it('control: one missing `additionalProperties: false` is caught, and would let a field through', () => {
        const mutated = JSON.parse(JSON.stringify(EVER_STATS_V1_SCHEMA)) as Json;
        const works = ((mutated.$defs as Json).works as Json).counts as Json;
        delete works.additionalProperties;
        expect(openObjects(mutated)).toEqual(['#/$defs/works/counts']);

        // The per-product branch alone is not enough to leak: the generic
        // `properties.counts` is closed too. Open both, as a careless edit of
        // the contract would, and the field gets through.
        const generic = (mutated.properties as Json).counts as Json;
        delete generic.additionalProperties;
        const validateMutated = compileStrictStatsSchema(mutated);
        const leaking = {
            ...JSON.parse(JSON.stringify(validReport)),
            counts: { ...validReport.counts, company_name: 1 },
        };
        expect(validateMutated(leaking)).toBe(true);
        expect(validateStatsReport(leaking).ok).toBe(false);
    });

    it('accepts the builder output strictly', () => {
        expect(validateStatsReport(validReport)).toEqual({ ok: true });
    });

    it('refuses a report with any extra field, at any level', () => {
        expect(validateStatsReport({ ...validReport, hostname: 'x' })).toMatchObject({
            ok: false,
            errors: [{ path: '/hostname', code: 'unknown_field' }],
        });
        expect(
            validateStatsReport({ ...validReport, counts: { ...validReport.counts, emails: 3 } }),
        ).toMatchObject({ ok: false, errors: [{ path: '/counts/emails', code: 'unknown_field' }] });
    });
});
