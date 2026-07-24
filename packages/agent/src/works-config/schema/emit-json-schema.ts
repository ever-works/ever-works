import { z } from 'zod/v4';
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

/**
 * Build the published JSON Schema for `.works/works.yml`.
 *
 * The runtime zod schema keeps `spec` structural (see the dispatch note in
 * `works-config.schema.ts`), but a published schema exists to drive editor
 * completion — so here the per-kind shapes are expanded into a `oneOf` keyed
 * on `spec.kind`. Unknown kinds still validate because every branch, and the
 * document itself, permits additional properties.
 */
export function buildWorksConfigJsonSchema(): Record<string, unknown> {
    const base = z.toJSONSchema(worksConfigSchema, { io: 'input' }) as Record<string, unknown>;

    const specBranches = Object.entries(KIND_SPEC_SCHEMAS).map(([kind, schema]) => {
        const branch = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
        return { title: `spec for kind: ${kind}`, ...branch };
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
                additionalProperties: true,
            },
        ],
    };

    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $id: WORKS_CONFIG_SCHEMA_ID,
        title: 'Ever Works — .works/works.yml',
        description:
            `Schema version ${WORKS_CONFIG_SCHEMA_VERSION}. Every field is optional: ` +
            'works.yml is a partial override of platform defaults, never a complete ' +
            'description of a Work. Unknown keys are preserved on write.',
        ...base,
        properties,
    };
}

/** Stable, byte-reproducible serialization — CI compares against the committed file. */
export function serializeWorksConfigJsonSchema(): string {
    return `${JSON.stringify(buildWorksConfigJsonSchema(), null, 4)}\n`;
}
