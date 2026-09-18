import * as fs from 'node:fs';
import * as path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import {
    APP_SPEC_SCHEMA_ID,
    buildAppSpecJsonSchema,
    buildAppSpecSchema,
    serializeAppSpecJsonSchema,
    addExtensionKeyPatterns,
} from '../emit-app-spec-json-schema';
import { APP_SPEC_REF, buildWorksConfigJsonSchema } from '../emit-json-schema';

/**
 * T8 — the stand-alone App spec JSON Schema (`schema.md` §25, plan §2.2:157-166).
 *
 * ACC-03-07 wants three things of the published document: the §24 examples
 * validate against it, the `x-` allowance of §2:74-75 survives publication, and
 * the committed artifact equals what the emitter produces. The tests below check
 * each with a **real** JSON Schema validator (Ajv in 2020-12 mode) rather than by
 * inspecting the document's shape — a schema that merely *looks* right is
 * exactly the failure mode the artifact exists to avoid.
 */

const GENERATED_PATH = path.join(__dirname, '..', 'app-spec.v1.schema.json');

/** Compile a document with a fresh Ajv and answer the validator. */
function validatorFor(schema: Record<string, unknown>): (data: unknown) => boolean {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    return ajv.compile(schema) as (data: unknown) => boolean;
}

/** The App spec document generator, compiled once — it is static. */
const validateAppSpec = validatorFor(buildAppSpecJsonSchema());

/**
 * The three valid examples of `schema.md` §24, extracted from the spec text
 * itself rather than transcribed — the idiom `app-spec.rules.spec.ts` and
 * `app-spec.validate.spec.ts` already use, so a change to the normative examples
 * reaches this suite without a second hand-copy to keep in step.
 */
function section24Examples(): readonly string[] {
    const specPath = path.join(
        // `packages/agent/src/works-config/schema/__tests__` → the repository root.
        __dirname,
        '../../../../../../docs/specs/features/app-works/APW-03-app-spec-and-catalog/schema.md',
    );
    const text = fs.readFileSync(specPath, 'utf8');
    const blocks = [...text.matchAll(/```yaml\n([\s\S]*?)```/g)].map((match) => match[1]);
    // §24.1–§24.3 are whole documents and open with the envelope's first line;
    // §24.4 is the *invalid* example and the earlier blocks are fragments.
    return blocks.filter(
        (block) => block.startsWith('version: 2') && block.includes('components:'),
    );
}

describe('App spec JSON Schema', () => {
    it('declares draft 2020-12, the published $id and a title', () => {
        const schema = buildAppSpecJsonSchema();
        expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
        expect(schema.$id).toBe(APP_SPEC_SCHEMA_ID);
        expect(schema.title).toContain('App spec');
    });

    it('is published at the URL `apps/api` serves it from (§25)', () => {
        expect(new URL(APP_SPEC_SCHEMA_ID).pathname).toBe('/api/schema/app-spec.schema.json');
    });

    it('describes every block of §5–§20 as a closed object', () => {
        const properties = buildAppSpecJsonSchema().properties as Record<string, unknown>;
        for (const key of [
            'kind',
            'appSpecVersion',
            'source',
            'blueprint',
            'license',
            'display',
            'build',
            'components',
            'dependencies',
            'env',
            'jobs',
            'cron',
            'domains',
            'smoke',
            'checks',
            'agents',
            'upstreamSync',
            'upstreamPullRequests',
            'provisioning',
        ]) {
            expect({ key, present: properties[key] !== undefined }).toEqual({ key, present: true });
        }
        expect(buildAppSpecJsonSchema().additionalProperties).toBe(false);
    });

    it('serializes deterministically', () => {
        expect(serializeAppSpecJsonSchema()).toBe(serializeAppSpecJsonSchema());
    });

    /**
     * The generated document is committed so it can be served without a build
     * step, vendored into the catalog repository and reviewed in diffs. This is
     * the drift guard: change the zod schema without regenerating and CI fails
     * here.
     *
     * Regenerate by deleting the file and re-running this spec — it is written
     * on first run, exactly as `works.v2.schema.json` is.
     */
    it('matches the committed app-spec.v1.schema.json', () => {
        const generated = serializeAppSpecJsonSchema();

        if (!fs.existsSync(GENERATED_PATH)) {
            fs.writeFileSync(GENERATED_PATH, generated, 'utf8');
        }

        const committed = fs.readFileSync(GENERATED_PATH, 'utf8');
        // If this fails, app-spec.v1.schema.json is stale — regenerate it
        // (see the comment above this test).
        expect(committed).toBe(generated);
    });
});

describe('the §24 examples validate against the published document (ACC-03-07)', () => {
    const examples = section24Examples();

    it('reads all three valid examples from schema.md', () => {
        expect(examples).toHaveLength(3);
    });

    it.each([
        ['§24.1', 0],
        ['§24.2', 1],
        ['§24.3', 2],
    ] as const)('%s validates', (_name, index) => {
        const document = parseYaml(examples[index]);
        expect({
            valid: validateAppSpec(document.spec),
            example: examples[index].slice(0, 40),
        }).toEqual({ valid: true, example: examples[index].slice(0, 40) });
    });

    /**
     * The non-vacuous control for the test above: a validator that accepted
     * everything would pass it too. §24.4's own defect — `replica` for
     * `replicas` — must be refused by the *document*, not only by the runtime
     * validator (FR-13).
     */
    it('rejects `replica` under an app component (§24.4)', () => {
        const document = parseYaml(examples[2]) as { spec: Record<string, any> };
        const components = document.spec.components as Array<Record<string, unknown>>;
        components[0].replica = 2;

        expect(validateAppSpec(document.spec)).toBe(false);
    });
});

describe('the x- allowance of §2:74-75 survives publication', () => {
    it('lets an extension key through at every depth, and still refuses a typo', () => {
        const document = {
            kind: 'app',
            appSpecVersion: 1,
            'x-platform': { note: 'root' },
            source: { relation: 'fork', upstream: { repo: 'example-org/helpdesk' }, 'x-src': 1 },
            components: [{ name: 'web', role: 'web', port: 8080, 'x-chart': { cpu: 2 } }],
            env: [{ name: 'PUBLIC_URL', from: 'domains.primary.url', 'x-note': 'ok' }],
        };

        expect(validateAppSpec(document)).toBe(true);

        const typo = {
            ...document,
            components: [{ name: 'web', role: 'web', port: 8080, replica: 2 }],
        };
        expect(validateAppSpec(typo)).toBe(false);
    });

    it('gives every closed object the pattern, and never overwrites one', () => {
        const document = buildAppSpecJsonSchema();
        let closed = 0;

        const walk = (node: unknown): void => {
            if (Array.isArray(node)) {
                node.forEach(walk);
                return;
            }
            if (node === null || typeof node !== 'object') return;
            const record = node as Record<string, unknown>;
            if (record['additionalProperties'] === false) {
                closed += 1;
                expect(record['patternProperties']).toEqual({ '^x-': {} });
            }
            Object.values(record).forEach(walk);
        };

        walk(document);
        // `appSpecSchema` is a `strictObject` per §5–§20 object, so there are
        // many; the assertion that matters is that none was missed.
        expect(closed).toBeGreaterThan(10);

        // Additive by construction: an existing `patternProperties` is kept and
        // an open object is untouched.
        const existing = { additionalProperties: false, patternProperties: { '^y-': {} } };
        expect(addExtensionKeyPatterns(existing)).toEqual({
            additionalProperties: false,
            patternProperties: { '^y-': {} },
        });
        expect(addExtensionKeyPatterns({ additionalProperties: true })).toEqual({
            additionalProperties: true,
        });
    });
});

describe('the envelope and the stand-alone document share one definition', () => {
    it('embeds exactly this body as $defs.appSpec, and points its if/then at it', () => {
        const envelope = buildWorksConfigJsonSchema() as {
            $defs: Record<string, unknown>;
            allOf: Array<{ then: { properties: { spec: { $ref: string } } } }>;
        };

        expect(envelope.$defs.appSpec).toEqual(buildAppSpecSchema());
        expect(envelope.allOf[0].then.properties.spec.$ref).toBe(APP_SPEC_REF);
    });

    it('drops the draft stamp from the body it embeds', () => {
        // A `$schema` inside `$defs` is ignored at best and confusing at worst;
        // the envelope sets it once, on its own root.
        expect(buildAppSpecSchema().$schema).toBeUndefined();
        expect(buildWorksConfigJsonSchema().$schema).toBe(
            'https://json-schema.org/draft/2020-12/schema',
        );
    });
});

/**
 * `apps/api`'s route imports this emitter as
 * `@ever-works/agent/works-config` (`buildAppSpecJsonSchema`), so the barrel must
 * keep re-exporting it — the API's own spec stubs that barrel for reasons of its
 * test runner and therefore cannot see this contract.
 */
describe('the package entry point (works-config/index.ts)', () => {
    /**
     * Loading that barrel pulls the whole `works-config` feature — every Nest
     * service, the repositories and the event listener — through ts-jest, which
     * takes ~30 s on a first compile. The suite's 30 s default is too close to
     * that to be reliable on a shared runner, so this one test raises its own
     * budget; it is the import that is slow, not the assertion.
     */
    it('re-exports the emitter and its $id', () => {
        const barrel = require('../../index') as Record<string, unknown>;

        expect(barrel.buildAppSpecJsonSchema).toBe(buildAppSpecJsonSchema);
        expect(barrel.serializeAppSpecJsonSchema).toBe(serializeAppSpecJsonSchema);
        expect(barrel.APP_SPEC_SCHEMA_ID).toBe(APP_SPEC_SCHEMA_ID);
        expect(barrel.buildWorksConfigJsonSchema).toBe(buildWorksConfigJsonSchema);
    }, 120_000);
});
