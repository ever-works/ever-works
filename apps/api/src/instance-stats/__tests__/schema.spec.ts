import Ajv2020 from 'ajv/dist/2020';
import type { DataSource } from 'typeorm';
import { SCHEMAS } from '@ever-co/connect-contracts';
import { validateStatsReport } from '@ever-co/connect-sdk';
import { createHarness } from './fixtures/harness.helper-spec';
import { createStatsDataSource, seedOneUserInstance } from './fixtures/works-seed.helper-spec';

type Json = Record<string, unknown>;

/** The published schema, from the pinned `@ever-co/connect-contracts`. */
const EVER_STATS_V1_SCHEMA = SCHEMAS.stats as Json;

/**
 * Another copy of a statistics schema compiled strictly (an unknown keyword or
 * an ambiguous schema is a compile error): the control below proves that a
 * weakened schema would let a field through.
 */
function compileStrict(schema: Json): (value: unknown) => boolean {
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    return (value: unknown) => validate(value) === true;
}

/**
 * Every object level of the published schema is closed, and the builder's
 * output passes the published checks (the Ever Platform SDK's
 * `validateStatsReport`, the platform's own).
 *
 * "Closed" means `additionalProperties: false`, or — for the currency maps,
 * the one place keys are not a fixed list — `additionalProperties` limited to
 * an integer schema AND `propertyNames` bound by a pattern AND
 * `maxProperties`. The meta-test walks every subschema; the control removes
 * one `additionalProperties: false` and shows both the meta-test and a
 * validator compiled from the weakened schema then let an unknown field
 * through, while the SDK still refuses it.
 */
/** Keywords whose subschemas apply to the SAME instance as the node that holds them. */
const IN_PLACE_ARRAYS = ['allOf', 'anyOf', 'oneOf'];
const IN_PLACE_SCHEMAS = ['if', 'then', 'else', 'not'];

/**
 * Every object level that is not closed. A branch of `oneOf`/`allOf`/`if`…
 * applies to the same object as its parent, so a closed parent covers it
 * (a property the branch names but the parent does not is refused by the
 * parent's `additionalProperties: false`); its nested schemas are still walked.
 */
function openObjects(schema: unknown, path = '#', covered = false): string[] {
    if (!schema || typeof schema !== 'object') return [];
    const node = schema as Json;
    const found: string[] = [];
    // An object-shaped subschema counts whether or not it says `type: 'object'`.
    const isObject =
        node.type === 'object' ||
        ['properties', 'patternProperties', 'additionalProperties', 'propertyNames'].some(
            (keyword) => keyword in node,
        );
    if (isObject) {
        const closed = node.additionalProperties === false;
        const boundedMap =
            typeof node.additionalProperties === 'object' &&
            node.additionalProperties !== null &&
            typeof (node.propertyNames as Json | undefined)?.pattern === 'string' &&
            typeof node.maxProperties === 'number';
        if (!closed && !boundedMap && !covered) found.push(path);
    }
    const closesHere = node.additionalProperties === false || covered;
    for (const [key, value] of Object.entries(node)) {
        if (Array.isArray(value)) {
            const inPlace = IN_PLACE_ARRAYS.includes(key) && closesHere;
            value.forEach((item, index) =>
                found.push(...openObjects(item, `${path}/${key}/${index}`, inPlace)),
            );
        } else if (value && typeof value === 'object') {
            const inPlace = IN_PLACE_SCHEMAS.includes(key) && closesHere;
            found.push(...openObjects(value, `${path}/${key}`, inPlace));
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
        const validateMutated = compileStrict(mutated);
        const leaking = {
            ...JSON.parse(JSON.stringify(validReport)),
            counts: { ...validReport.counts, company_name: 1 },
        };
        expect(validateMutated(leaking)).toBe(true);
        expect(validateStatsReport(leaking).ok).toBe(false);
    });

    it('control: a branch under an OPEN parent is not covered', () => {
        const mutated = JSON.parse(JSON.stringify(EVER_STATS_V1_SCHEMA)) as Json;
        expect(Array.isArray(mutated.oneOf)).toBe(true);
        delete mutated.additionalProperties;
        const open = openObjects(mutated);
        expect(open).toContain('#');
        expect(open.filter((path) => path.startsWith('#/oneOf/')).length).toBeGreaterThan(0);
    });

    it('control: an object-shaped subschema without `type` is checked all the same', () => {
        const mutated = JSON.parse(JSON.stringify(EVER_STATS_V1_SCHEMA)) as Json;
        const works = ((mutated.$defs as Json).works as Json).counts as Json;
        expect(works.properties).toBeDefined();
        delete works.type;
        delete works.additionalProperties;
        expect(openObjects(mutated)).toEqual(['#/$defs/works/counts']);
    });

    it('accepts the builder output strictly', () => {
        expect(validateStatsReport(validReport).ok).toBe(true);
    });

    /** The field errors of a refused report (`[]` when it is accepted). */
    const refusal = (report: unknown) => {
        const result = validateStatsReport(report);
        // `in` narrows whatever the compiler's null checks (this app runs without them).
        return 'error' in result
            ? result.error.errors.map(({ path, code }) => ({ path, code }))
            : [];
    };

    it('refuses a report with any extra field, at any level', () => {
        expect(refusal({ ...validReport, hostname: 'x' })).toEqual([
            { path: '/hostname', code: 'unknown_field' },
        ]);
        expect(refusal({ ...validReport, counts: { ...validReport.counts, emails: 3 } })).toEqual([
            { path: '/counts/emails', code: 'unknown_field' },
        ]);
    });
});
