import * as fs from 'node:fs';
import * as path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import {
    APP_SPEC_REF,
    WORKS_CONFIG_SCHEMA_ID,
    buildWorksConfigJsonSchema,
    serializeWorksConfigJsonSchema,
} from '../emit-json-schema';
import { buildAppSpecSchema } from '../emit-app-spec-json-schema';
import { KIND_SPEC_SCHEMAS } from '../works-config.schema';

const GENERATED_PATH = path.join(__dirname, '..', 'works.v2.schema.json');

/** A real validator over the published document — shape assertions alone cannot
 * tell a usable schema from an unsatisfiable one. */
function validatorFor(document: Record<string, unknown>): (data: unknown) => boolean {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    return ajv.compile(document) as (data: unknown) => boolean;
}

describe('works.yml JSON Schema', () => {
    it('declares a draft, an $id and a title', () => {
        const schema = buildWorksConfigJsonSchema();
        expect(schema.$schema).toMatch(/json-schema\.org/);
        expect(schema.$id).toBe(WORKS_CONFIG_SCHEMA_ID);
        expect(schema.title).toContain('works.yml');
    });

    it('exposes the v1 root keys so editors complete them', () => {
        const properties = buildWorksConfigJsonSchema().properties as Record<string, unknown>;
        for (const key of [
            'name',
            'initial_prompt',
            'website_repo',
            'schedule_cadence',
            'version',
            'kind',
            'spec',
        ]) {
            expect({ key, present: properties[key] !== undefined }).toEqual({
                key,
                present: true,
            });
        }
    });

    it('expands spec into one branch per known kind, plus an escape hatch', () => {
        const properties = buildWorksConfigJsonSchema().properties as Record<string, any>;
        const branches = properties.spec.oneOf as Array<{ title?: string }>;

        // One per known kind + the unrecognised-kind passthrough.
        expect(branches).toHaveLength(Object.keys(KIND_SPEC_SCHEMAS).length + 1);

        for (const kind of Object.keys(KIND_SPEC_SCHEMAS)) {
            expect({
                kind,
                hasBranch: branches.some((b) => b.title === `spec for kind: ${kind}`),
            }).toEqual({ kind, hasBranch: true });
        }
        expect(branches.some((branch) => branch.title === 'spec for an unrecognised kind')).toBe(
            true,
        );
    });

    it('serializes deterministically', () => {
        expect(serializeWorksConfigJsonSchema()).toBe(serializeWorksConfigJsonSchema());
    });

    /**
     * The generated document is committed so it can be served without a build
     * step and reviewed in diffs. This is the drift guard: change the zod
     * schema without regenerating and CI fails here.
     *
     * Regenerate with:
     *   pnpm --filter @ever-works/agent exec jest works-config/schema -u
     * (or simply delete the file and re-run — it is written on first run.)
     */
    it('matches the committed works.v2.schema.json', () => {
        const generated = serializeWorksConfigJsonSchema();

        if (!fs.existsSync(GENERATED_PATH)) {
            fs.writeFileSync(GENERATED_PATH, generated, 'utf8');
        }

        const committed = fs.readFileSync(GENERATED_PATH, 'utf8');
        // If this fails, works.v2.schema.json is stale — regenerate it
        // (see the comment above this test).
        expect(committed).toBe(generated);
    });
});

/**
 * T8 — the `app` branch of the envelope (plan §2.2:159-166, FR-13).
 *
 * The tests below run the **published document** through a JSON Schema
 * validator, because the questions ACC-03-07 asks are about what the document
 * *accepts*, not about what it contains: `replica` under an app component must
 * be refused, and a kind this build does not know must still be allowed.
 */
describe('works.yml JSON Schema — the app branch', () => {
    const validate = validatorFor(buildWorksConfigJsonSchema());

    it('pins `kind: app` to the App spec at the root, via $defs (plan §2.2:159-161)', () => {
        const schema = buildWorksConfigJsonSchema();

        expect(schema.allOf).toEqual([
            {
                if: { properties: { kind: { const: 'app' } }, required: ['kind'] },
                then: { properties: { spec: { $ref: APP_SPEC_REF } } },
            },
        ]);
        expect((schema.$defs as Record<string, unknown>).appSpec).toEqual(buildAppSpecSchema());
    });

    it('rejects `replica` under an app component', () => {
        // `spec.kind` is deliberately absent — §24.1's own shape, and §1:63's
        // "when absent, `spec.kind: app` selects this schema": the root `kind`
        // is what pins the block to the App spec.
        const valid = {
            version: 2,
            kind: 'app',
            spec: {
                appSpecVersion: 1,
                source: { relation: 'fork', upstream: { repo: 'example-org/helpdesk' } },
                build: { strategy: 'dockerfile' },
                components: [{ name: 'web', role: 'web', port: 8080 }],
            },
        };
        expect(validate(valid)).toBe(true);

        const typo = {
            ...valid,
            spec: {
                ...valid.spec,
                components: [{ name: 'web', role: 'web', port: 8080, replica: 2 }],
            },
        };
        expect(validate(typo)).toBe(false);
    });

    it('still accepts a spec for an unrecognised kind, and for every kind it lists', () => {
        expect(
            validate({
                version: 2,
                kind: 'storefront',
                spec: { kind: 'storefront', catalog: { currency: 'USD' } },
            }),
        ).toBe(true);

        // The escape branch excludes the kinds the document lists — which is
        // what lets a `oneOf` with a catch-all branch stay satisfiable. Each
        // listed kind must therefore reach its own branch.
        expect(
            validate({ version: 2, kind: 'website', spec: { kind: 'website', template: 'web' } }),
        ).toBe(true);
        expect(
            validate({ version: 2, kind: 'blog', spec: { kind: 'blog', content_dir: 'content' } }),
        ).toBe(true);
    });

    it('accepts the x- keys the runtime strips, and only those', () => {
        const document = {
            version: 2,
            kind: 'app',
            spec: {
                kind: 'app',
                'x-anything': true,
                source: { relation: 'fork', 'x-note': 'kept' },
                components: [{ name: 'web', role: 'web', port: 8080, 'x-chart': {} }],
            },
        };

        expect(validate(document)).toBe(true);
        expect(
            validate({
                ...document,
                spec: {
                    ...document.spec,
                    components: [{ name: 'web', role: 'web', port: 8080, replica: 2 }],
                },
            }),
        ).toBe(false);
    });

    it('gives the app branch and $defs the same x- allowance', () => {
        const branches = (
            (buildWorksConfigJsonSchema().properties as Record<string, any>).spec.oneOf as Array<{
                title?: string;
                required?: string[];
                patternProperties?: unknown;
                additionalProperties?: unknown;
            }>
        ).filter((branch) => branch.title === 'spec for kind: app');

        expect(branches).toHaveLength(1);
        expect(branches[0].additionalProperties).toBe(false);
        expect(branches[0].patternProperties).toEqual({ '^x-': {} });
        // The branch is keyed on `kind`, and says so — the other kinds get this
        // from their required `literal` (see the emitter's header).
        expect(branches[0].required).toEqual(['kind']);
    });

    /**
     * The program's own examples, as documents. Before T8 the envelope rejected
     * every one of them: each matched its kind's branch **and** the catch-all
     * escape branch, and a `oneOf` needs exactly one. Reading them from
     * `schema.md` rather than transcribing them is the same rule
     * `app-spec.rules.spec.ts` follows — a published schema that refuses the
     * running example is wrong by definition.
     */
    it('validates the three §24 examples as whole documents', () => {
        const specPath = path.join(
            __dirname,
            '../../../../../../docs/specs/features/app-works/APW-03-app-spec-and-catalog/schema.md',
        );
        const blocks = [
            ...fs.readFileSync(specPath, 'utf8').matchAll(/```yaml\n([\s\S]*?)```/g),
        ].map((match) => match[1]);
        const examples = blocks.filter(
            (block) => block.startsWith('version: 2') && block.includes('components:'),
        );
        expect(examples).toHaveLength(3);

        for (const example of examples) {
            expect({
                valid: validate(parseYaml(example)),
                example: example.slice(0, 40),
            }).toEqual({ valid: true, example: example.slice(0, 40) });
        }
    });
});
