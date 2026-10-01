import { z } from 'zod/v4';
import { addExtensionKeyPatterns, buildAppSpecSchema } from './emit-app-spec-json-schema';
import {
    KIND_SPEC_SCHEMAS,
    WORKS_CONFIG_SCHEMA_VERSION,
    worksConfigSchema,
} from './works-config.schema';

/**
 * The canonical `$id` under which the schema is published.
 *
 * Editors resolve `# yaml-language-server: $schema=<this>` against it, and
 * `apps/api` serves the generated document at the matching path.
 */
export const WORKS_CONFIG_SCHEMA_ID = 'https://api.ever.works/api/schema/works.yml.schema.json';

/** The `$ref` the `kind: app` branch of {@link buildWorksConfigJsonSchema} points at. */
export const APP_SPEC_REF = '#/$defs/appSpec';

/**
 * Build the published JSON Schema for `.works/works.yml`.
 *
 * The runtime zod schema keeps `spec` structural (see the dispatch note in
 * `works-config.schema.ts`), but a published schema exists to drive editor
 * completion — so here the per-kind shapes are expanded into a `oneOf` keyed
 * on `spec.kind`. Unknown kinds still validate because the escape branch
 * permits additional properties.
 *
 * ## Keeping the `oneOf` satisfiable
 *
 * A `oneOf` requires **exactly one** branch to match, and a catch-all branch
 * matches every object — so a spec that matched a kind's branch also matched
 * the escape branch, and the `oneOf` failed. Measured with Ajv against the
 * document this function emitted before T8: `spec: { kind: website }` and the
 * `kind: app` examples of `schema.md` §24 were both **rejected**. Two
 * properties restore the intended meaning without dropping a branch:
 *
 * 1. **Every branch requires the `kind` it is keyed on.** The other kinds
 *    already do — their `kind` is a required `literal` — so this is only ever
 *    the App branch's own key. A `spec` block that names no kind then matches
 *    no kind branch and falls to the escape branch, which is what §1:63's
 *    "when absent, `spec.kind: app` selects this schema" needs: the **root**
 *    `kind: app` is what pins such a document to the App spec, through the
 *    `allOf` below.
 * 2. **The escape branch excludes the kinds this document lists.** A known
 *    kind is validated by its own branch and by nothing else; an unknown kind
 *    still takes the escape branch — which is the branch's whole purpose.
 *
 * Every branch, every title and the total branch count are unchanged.
 *
 * ## The `app` branch (`plan §2.2:159-161`, FR-13)
 *
 * `spec.kind: app` selects the App spec through the `oneOf` like every other
 * kind, and the `$defs.appSpec` entry is that same document. But a document
 * whose **root** says `kind: app` is constrained by the root `allOf` even when
 * its `spec` block names no kind at all, and even though the escape branch
 * accepts such a block: that is what makes an App typo an error rather than
 * something the catch-all absorbs (FR-13).
 *
 * ## `x-` keys (§2:74-75)
 *
 * Every object emitted with `additionalProperties: false` also gains
 * `patternProperties: { "^x-": {} }` — plan §2.2:162-163, and the reconciliation
 * of the published document with the runtime's `stripExtensionKeys`. See
 * `emit-app-spec-json-schema.ts` for why that pair is exactly equivalent.
 */
export function buildWorksConfigJsonSchema(): Record<string, unknown> {
    const base = z.toJSONSchema(worksConfigSchema, { io: 'input' }) as Record<string, unknown>;
    const knownKinds = Object.keys(KIND_SPEC_SCHEMAS);

    const specBranches = Object.entries(KIND_SPEC_SCHEMAS).map(([kind, schema]) => {
        const branch = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
        const required = Array.isArray(branch.required) ? (branch.required as string[]) : [];
        return {
            title: `spec for kind: ${kind}`,
            ...branch,
            // The key this branch is keyed on — see the header. Added only when
            // the kind schema does not already require it.
            ...(required.includes('kind') ? {} : { required: [...required, 'kind'] }),
        };
    });

    const properties = { ...(base.properties as Record<string, unknown> | undefined) };
    properties.spec = {
        description:
            'Kind-specific configuration. The accepted shape depends on `kind`. ' +
            'A kind this schema does not list is still allowed — its spec is ' +
            'preserved as-is and not validated.',
        oneOf: [
            ...specBranches,
            {
                title: 'spec for an unrecognised kind',
                type: 'object',
                // …but not one of the kinds above: see this function's header.
                not: {
                    properties: { kind: { enum: knownKinds } },
                    required: ['kind'],
                },
                additionalProperties: true,
            },
        ],
    };

    return addExtensionKeyPatterns({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: WORKS_CONFIG_SCHEMA_ID,
        title: 'Ever Works — .works/works.yml',
        description:
            `Schema version ${WORKS_CONFIG_SCHEMA_VERSION}. Every field is optional: ` +
            'works.yml is a partial override of platform defaults, never a complete ' +
            'description of a Work. Unknown keys are preserved on write.',
        ...base,
        properties,
        allOf: [
            {
                if: {
                    properties: { kind: { const: 'app' } },
                    required: ['kind'],
                },
                then: { properties: { spec: { $ref: APP_SPEC_REF } } },
            },
        ],
        $defs: {
            ...(base.$defs as Record<string, unknown> | undefined),
            appSpec: buildAppSpecSchema(),
        },
    }) as Record<string, unknown>;
}

/** Stable, byte-reproducible serialization — CI compares against the committed file. */
export function serializeWorksConfigJsonSchema(): string {
    return `${JSON.stringify(buildWorksConfigJsonSchema(), null, 4)}\n`;
}
