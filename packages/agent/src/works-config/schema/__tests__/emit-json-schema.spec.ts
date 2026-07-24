import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    WORKS_CONFIG_SCHEMA_ID,
    buildWorksConfigJsonSchema,
    serializeWorksConfigJsonSchema,
} from '../emit-json-schema';
import { KIND_SPEC_SCHEMAS } from '../works-config.schema';

const GENERATED_PATH = path.join(__dirname, '..', 'works.v2.schema.json');

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
