import { z } from 'zod/v4';
import { appSpecSchema } from './app-spec.schema';

/**
 * The stand-alone JSON Schema for the **App spec** — `schema.md` §25's
 * "Stand-alone App spec JSON Schema" row, published at
 * {@link APP_SPEC_SCHEMA_ID} and served by `apps/api`'s
 * `GET /api/schema/app-spec.schema.json`.
 *
 * Owning epic: **APW-03** (task T8). Plan: `plan.md` §2.2:157-166 ("A
 * post-processing walk adds `patternProperties: { "^x-": {} }` to every object
 * emitted with `additionalProperties: false`" and "`emit-app-spec-json-schema.ts`
 * _(new)_ emits the stand-alone `app-spec.v1.schema.json` with `$id`
 * `https://api.ever.works/api/schema/app-spec.schema.json`; committed and
 * drift-guarded exactly like `works.v2.schema.json`"). Acceptance: ACC-03-07.
 *
 * ## One definition, three consumers
 *
 * {@link buildAppSpecSchema} is the body, and it is the same object graph the
 * envelope's `$defs.appSpec` carries (`emit-json-schema.ts`) and the root of
 * {@link buildAppSpecJsonSchema}. Both documents therefore describe the App spec
 * identically by construction: the envelope's `allOf`/`if`/`then` for
 * `kind: app` and this stand-alone document cannot drift from each other, only
 * together.
 *
 * ## What JSON Schema can and cannot say about the App spec
 *
 * `appSpecSchema` (T3) is deliberately free of `.refine()`/`.check()` calls —
 * zod silently drops refinements from `z.toJSONSchema()` output, so a refinement
 * would leave an editor accepting a document the platform refuses. What the
 * emitted document therefore carries is the **structure**: types, closed
 * vocabularies, bounds, presence, and the two envelope keys of §1. §21's
 * reference grammar and §22's cross-field rules R1–R27 are not expressible here
 * at all — they are the validator's (`app-spec.validate.ts`), and §25 closes
 * with exactly that sentence: "editors validate structure, the platform
 * validates everything."
 *
 * ## `x-` keys (§2:74-75)
 *
 * "Any key starting with `x-` is allowed at any depth inside `spec`, preserved,
 * and ignored." The runtime enforces it by removing those keys from a copy
 * before parsing (`stripExtensionKeys`); a published schema has no such
 * step, and `additionalProperties: false` alone would make every extension key a
 * validation error in an editor while the platform accepts it. The reconciliation
 * is plan §2.2:162-163's post-processing walk: every object emitted with
 * `additionalProperties: false` also gets `patternProperties: { "^x-": {} }`.
 * JSON Schema applies `additionalProperties` only to properties that
 * `properties` and `patternProperties` did **not** match, so a typo still lands
 * on `additionalProperties: false` while an extension key is let through — the
 * "typo vs extension" distinction `validator-rules.md` C1 draws.
 */

/** The canonical `$id` — the URL this document is published and served under. */
export const APP_SPEC_SCHEMA_ID = 'https://api.ever.works/api/schema/app-spec.schema.json';

/** The `$schema` every document this module publishes declares. */
export const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

/** The extension-key prefix of §2:74. */
export const EXTENSION_KEY_PREFIX = 'x-';

/** The document's title, shared by the envelope's `$defs` entry and the stand-alone file. */
export const APP_SPEC_SCHEMA_TITLE = 'Ever Works — App spec (kind: app)';

/** The document's description, written for the person reading it in an editor. */
export const APP_SPEC_SCHEMA_DESCRIPTION =
    'The `spec` block of a `.works/works.yml` whose kind is `app`, and the whole ' +
    'document of a stand-alone App spec. Structure only: the reference and ' +
    'cross-field rules are validated by the platform. Keys starting with `x-` are ' +
    'allowed at any depth and ignored.';

/**
 * Add `patternProperties: { "^x-": {} }` to every object this walk reaches that
 * was emitted with `additionalProperties: false` (plan §2.2:162-163).
 *
 * **Additive by construction.** A schema that already declares
 * `patternProperties` keeps it: the walk never overwrites one, and an object
 * whose `additionalProperties` is `true` (every `looseObject`, and the envelope's
 * escape hatch) is untouched. The published documents therefore only ever gain
 * the `x-` allowance.
 *
 * The walk is generic rather than keyword-aware: it descends into every nested
 * object and array, so `properties`, `items`, `prefixItems`, `$defs`, `oneOf`,
 * `anyOf`, `allOf`, `if`/`then`/`else` and a schema-valued
 * `additionalProperties` are all covered without this module keeping a list of
 * the keywords zod happens to emit today. A non-schema object that carries an
 * `additionalProperties: false` key of its own (a `const` fixture, say) is not a
 * case these schemas produce, and adding the key there would be inert.
 *
 * Mutates the graph it is given — safe because both callers hand it the fresh
 * result of `z.toJSONSchema`, whose output is never shared — and returns it so a
 * caller can wrap the call around a document in one expression.
 */
export function addExtensionKeyPatterns(node: unknown): unknown {
    if (Array.isArray(node)) {
        for (const item of node) addExtensionKeyPatterns(item);
        return node;
    }
    if (node === null || typeof node !== 'object') return node;

    const record = node as Record<string, unknown>;
    if (record['additionalProperties'] === false && record['patternProperties'] === undefined) {
        record['patternProperties'] = { [`^${EXTENSION_KEY_PREFIX}`]: {} };
    }
    for (const value of Object.values(record)) addExtensionKeyPatterns(value);
    return node;
}

/**
 * The App spec's JSON Schema **body** — everything but `$schema` and `$id`.
 *
 * This is what `emit-json-schema.ts` embeds as `$defs.appSpec`, which is why the
 * document-level keywords are not set here: `$id` inside a subschema would
 * re-base the resource, and `$schema` is only meaningful at a resource root.
 */
export function buildAppSpecSchema(): Record<string, unknown> {
    const body = z.toJSONSchema(appSpecSchema, { io: 'input' }) as Record<string, unknown>;
    // `z.toJSONSchema` stamps the draft at the root of what it produced. Here
    // that root is about to become a subschema of the envelope, so the stamp is
    // dropped and `buildAppSpecJsonSchema` sets it once, on the real root.
    delete body.$schema;

    return addExtensionKeyPatterns({
        title: APP_SPEC_SCHEMA_TITLE,
        description: APP_SPEC_SCHEMA_DESCRIPTION,
        ...body,
    }) as Record<string, unknown>;
}

/** The stand-alone published document: {@link buildAppSpecSchema} plus its root keywords. */
export function buildAppSpecJsonSchema(): Record<string, unknown> {
    return {
        $schema: JSON_SCHEMA_DRAFT,
        $id: APP_SPEC_SCHEMA_ID,
        ...buildAppSpecSchema(),
    };
}

/** Stable, byte-reproducible serialization — CI compares against the committed file. */
export function serializeAppSpecJsonSchema(): string {
    return `${JSON.stringify(buildAppSpecJsonSchema(), null, 4)}\n`;
}
