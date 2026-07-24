import { z } from 'zod/v4';

/**
 * `.works/works.yml` — the versioned schema.
 *
 * ## Why this exists
 *
 * Until now `.works/works.yml` had no validator at all. `WorksConfigService`
 * hand-coerced a handful of known keys and silently dropped anything it did
 * not recognise, so a typo produced no error — just a Work that quietly
 * behaved as if the field had never been written. There was also no schema
 * to point an editor at, and nothing described the fields that only some
 * kinds of Work need.
 *
 * ## Design
 *
 * **Additive envelope.** v2 is v1 plus three optional keys — `version`,
 * `kind`, `spec`. Every file already in the wild is a valid v2 file, and a
 * `default`-kind Work's file stays byte-identical to what is written today.
 *
 * **`version` is advisory, never gating.** Absent means v1. A version newer
 * than this build understands produces a warning and is parsed leniently
 * rather than rejected — refusing to read a file written by a newer server
 * would strand the user's own repository. (Docker Compose learned this the
 * hard way with its `version:` key.)
 *
 * **Unknown keys are preserved, everywhere.** Every object is a
 * `looseObject`. This is load-bearing rather than lax: the writer
 * round-trips the parsed document back to the user's git repository, so a
 * stripping `z.object()` would silently delete any key this build does not
 * know — including keys written by a NEWER build, and hand-authored ones.
 *
 * **`spec` is discriminated on `kind`.** Per-kind configuration nests under
 * `spec` rather than sitting at the root, which keeps the flat v1 root
 * namespace clean and gives the deep-merge in `DataRepository.mergeConfig`
 * exactly one new key to reason about.
 *
 * **Unknown kinds parse.** `spec` for an unrecognised kind falls through to
 * a permissive passthrough, so a `kind: storefront` written by a newer
 * server round-trips intact instead of being erased.
 */

/** Bumped only when the envelope itself changes shape, not per-kind spec edits. */
export const WORKS_CONFIG_SCHEMA_VERSION = 2;

/**
 * Security: `initial_prompt` is attacker-controlled external content that is
 * forwarded into the LLM generation pipeline. Bounded here as
 * defense-in-depth; mirrors `MAX_INITIAL_PROMPT_LENGTH` in
 * `works-config.service.ts`. Legitimate prompts are far below this.
 */
const MAX_INITIAL_PROMPT_LENGTH = 8000;

const nonEmptyString = z.string().trim().min(1);

/** A repository reference — `owner/repo`, or a full https URL. */
const repoRef = z.string().trim().max(400);

const scheduleCadence = z.enum(['hourly', 'daily', 'weekly', 'monthly']);

const activitySync = z.looseObject({
    mode: z.enum(['pull', 'push', 'disabled']).optional(),
});

const seo = z.looseObject({
    title: z.string().optional(),
    description: z.string().optional(),
    keywords: z.union([z.string(), z.array(z.string())]).optional(),
    author: z.string().optional(),
    image: z.string().optional(),
    twitter: z.string().optional(),
    url: z.string().optional(),
});

const branding = z.looseObject({
    logo: z.string().optional(),
    favicon: z.string().optional(),
    theme: z.string().optional(),
    locale: z.string().optional(),
});

// ── Per-kind `spec` shapes ────────────────────────────────────────────────
//
// Each captures what that kind's generator actually consumes. Every field is
// optional: `works.yml` is a partial override of platform defaults, never a
// complete description, so requiring anything here would reject valid files.

const websiteSpec = z.looseObject({
    kind: z.literal('website'),
    template: nonEmptyString.optional(),
    pages: z
        .array(
            z.looseObject({
                path: nonEmptyString,
                title: z.string().optional(),
                prompt: z.string().optional(),
            }),
        )
        .optional(),
    nav: z
        .looseObject({
            header: z.array(z.looseObject({ label: z.string(), href: z.string() })).optional(),
            footer: z.array(z.looseObject({ label: z.string(), href: z.string() })).optional(),
        })
        .optional(),
    branding: branding.optional(),
    seo: seo.optional(),
    analytics: z.looseObject({ provider: z.string().optional() }).optional(),
});

const landingPageSpec = z.looseObject({
    kind: z.literal('landing-page'),
    template: nonEmptyString.optional(),
    hero: z
        .looseObject({
            headline: z.string().optional(),
            subheadline: z.string().optional(),
            cta: z.looseObject({ label: z.string(), href: z.string() }).optional(),
        })
        .optional(),
    sections: z
        .array(z.looseObject({ type: nonEmptyString, title: z.string().optional() }))
        .optional(),
    capture: z
        .looseObject({
            enabled: z.boolean().optional(),
            destination: z.string().optional(),
        })
        .optional(),
    branding: branding.optional(),
    seo: seo.optional(),
    analytics: z.looseObject({ provider: z.string().optional() }).optional(),
});

const blogSpec = z.looseObject({
    kind: z.literal('blog'),
    template: nonEmptyString.optional(),
    content_dir: z.string().optional(),
    authors: z
        .array(z.looseObject({ name: nonEmptyString, bio: z.string().optional() }))
        .optional(),
    taxonomies: z
        .looseObject({
            categories: z.array(z.string()).optional(),
            tags: z.array(z.string()).optional(),
        })
        .optional(),
    feed: z.looseObject({ enabled: z.boolean().optional() }).optional(),
    pagination: z.looseObject({ per_page: z.number().int().positive().optional() }).optional(),
    generation: z
        .looseObject({
            cadence: scheduleCadence.optional(),
            topics_prompt: z.string().max(MAX_INITIAL_PROMPT_LENGTH).optional(),
            posts_per_run: z.number().int().positive().optional(),
        })
        .optional(),
    branding: branding.optional(),
    seo: seo.optional(),
});

const directorySpec = z.looseObject({
    kind: z.literal('directory'),
    template: nonEmptyString.optional(),
    categories: z.array(z.union([z.string(), z.looseObject({ name: nonEmptyString })])).optional(),
    tags: z.array(z.union([z.string(), z.looseObject({ name: nonEmptyString })])).optional(),
    item_fields: z
        .array(z.looseObject({ name: nonEmptyString, type: z.string().optional() }))
        .optional(),
    sources: z.array(z.looseObject({ url: z.string().optional() })).optional(),
    submissions: z
        .looseObject({
            enabled: z.boolean().optional(),
            moderation: z.enum(['auto', 'manual']).optional(),
        })
        .optional(),
    comparisons: z.looseObject({ enabled: z.boolean().optional() }).optional(),
    branding: branding.optional(),
    seo: seo.optional(),
});

const awesomeRepoSpec = z.looseObject({
    kind: z.literal('awesome-repo'),
    template: nonEmptyString.optional(),
    source: z
        .looseObject({
            repo: repoRef.optional(),
            branch: z.string().optional(),
            file: z.string().optional(),
        })
        .optional(),
    sync: z.looseObject({ cadence: scheduleCadence.optional() }).optional(),
    // Mirrors `MarkdownReadmeConfig` on the Work entity.
    readme: z
        .looseObject({
            header: z.string().optional(),
            footer: z.string().optional(),
            overwriteDefaultHeader: z.boolean().optional(),
            overwriteDefaultFooter: z.boolean().optional(),
            toc: z.boolean().optional(),
            badges: z.array(z.string()).optional(),
        })
        .optional(),
    enrich: z.looseObject({ enabled: z.boolean().optional() }).optional(),
});

const companySpec = z.looseObject({
    kind: z.literal('company'),
    organization: z.string().optional(),
    /** Path to the richer `agentcompanies/v1` sidecar, when present. */
    company_manifest: z.string().optional(),
    departments: z.array(z.looseObject({ name: nonEmptyString })).optional(),
    staffing: z
        .array(z.looseObject({ role: nonEmptyString, agent: z.string().optional() }))
        .optional(),
    branding: branding.optional(),
});

/**
 * The per-kind spec schemas, dispatched by kind.
 *
 * Deliberately NOT a `z.union([discriminatedUnion, passthrough])`: a union
 * would let an INVALID typed spec (say `blog` with `posts_per_run: "three"`)
 * fall through to the permissive branch and validate, which defeats the
 * point of having typed specs at all. Instead the kind is looked up here and
 * validated strictly when known; only a genuinely unrecognised kind takes
 * the passthrough path.
 */
export const KIND_SPEC_SCHEMAS = {
    website: websiteSpec,
    'landing-page': landingPageSpec,
    blog: blogSpec,
    directory: directorySpec,
    'awesome-repo': awesomeRepoSpec,
    company: companySpec,
} as const;

export type KnownSpecKind = keyof typeof KIND_SPEC_SCHEMAS;

/**
 * Structural schema for `spec` — every spec is an object and MAY name its
 * kind. The per-kind field validation runs separately in
 * `validateWorksConfig`, which is what lets an unknown kind pass through
 * while a known one is checked strictly.
 */
export const worksConfigSpecSchema = z.looseObject({
    kind: z.string().trim().max(32).optional(),
});

/**
 * The full `.works/works.yml` document.
 *
 * The v1 root keys are all still here and still optional; `version`, `kind`
 * and `spec` are the v2 additions.
 */
export const worksConfigSchema = z.looseObject({
    /** Advisory. Absent ⇒ v1. Newer than we know ⇒ warn, parse anyway. */
    version: z.number().int().positive().optional(),
    /**
     * Which kind of Work this repository describes. Absent ⇒ `default`.
     * Deliberately a plain string, not an enum: an unrecognised value must
     * round-trip rather than fail, so the server can ship a new kind
     * without every existing client rejecting the file.
     */
    kind: z.string().trim().max(32).optional(),

    // ── v1 root keys ──────────────────────────────────────────────────
    name: z.string().optional(),
    title: z.string().optional(),
    initial_prompt: z.string().max(MAX_INITIAL_PROMPT_LENGTH).optional(),
    model: z.string().optional(),
    website_repo: repoRef.optional(),
    schedule_cadence: scheduleCadence.optional(),
    deploy_provider: z.string().optional(),
    deployProvider: z.string().optional(),
    activity_sync: activitySync.optional(),
    providers: z.looseObject({}).optional(),

    /** Kind-specific configuration. */
    spec: worksConfigSpecSchema.optional(),
});

export type WorksConfigDocument = z.infer<typeof worksConfigSchema>;
export type WorksConfigSpec = z.infer<typeof worksConfigSpecSchema>;

export interface WorksConfigValidation {
    /** The parsed document. Present whenever the root was a valid object. */
    data?: WorksConfigDocument;
    /** Blocking problems — the document could not be understood. */
    errors: string[];
    /** Non-blocking observations (e.g. a newer `version`). */
    warnings: string[];
}

/**
 * Validate an already-YAML-parsed document.
 *
 * Never throws. A `.works/works.yml` lives in the user's own repository and
 * a schema quibble must not be able to take their Work offline — callers
 * decide whether to surface `errors` or proceed on `data`.
 */
export function validateWorksConfig(raw: unknown): WorksConfigValidation {
    const warnings: string[] = [];

    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {
            errors: ['.works/works.yml must contain a YAML object at the root'],
            warnings,
        };
    }

    const version = (raw as Record<string, unknown>).version;
    if (typeof version === 'number' && version > WORKS_CONFIG_SCHEMA_VERSION) {
        warnings.push(
            `works.yml declares version ${version} but this build understands ` +
                `${WORKS_CONFIG_SCHEMA_VERSION}. Parsing leniently; unrecognised keys are preserved.`,
        );
    }

    const result = worksConfigSchema.safeParse(raw);
    if (!result.success) {
        return { errors: formatIssues(result.error.issues), warnings };
    }

    // Per-kind spec validation. The kind is taken from `spec.kind` when
    // present, otherwise from the root `kind` — a file that says
    // `kind: blog` at the root need not repeat itself inside `spec`.
    const spec = result.data.spec;
    if (spec) {
        const specKind = spec.kind ?? result.data.kind;
        // Security: own-property lookup ONLY. `specKind` is attacker-supplied
        // (a crafted repo's works.yml), and a bare index on an object literal
        // resolves prototype-chain names — `kind: constructor` /
        // `kind: __proto__` / `kind: toString` would return a truthy
        // non-schema value whose `.safeParse` then THROWS, breaking this
        // function's never-throws contract and (on the write path) locking
        // the Work's config permanently: the throw happens at read, before
        // any rewrite could repair the file.
        const kindSchema =
            specKind && Object.prototype.hasOwnProperty.call(KIND_SPEC_SCHEMAS, specKind)
                ? KIND_SPEC_SCHEMAS[specKind as KnownSpecKind]
                : undefined;

        if (kindSchema) {
            const specResult = kindSchema.safeParse({ ...spec, kind: specKind });
            if (!specResult.success) {
                return {
                    errors: formatIssues(specResult.error.issues, 'spec'),
                    warnings,
                };
            }
        } else if (specKind) {
            warnings.push(
                `works.yml declares kind "${specKind}", which this build does not recognise. ` +
                    `The spec block is preserved as-is but not validated.`,
            );
        }
    }

    return { data: result.data, errors: [], warnings };
}

function formatIssues(issues: readonly z.core.$ZodIssue[], prefix?: string): string[] {
    return issues.map((issue) => {
        const path = [prefix, ...issue.path.map(String)].filter(Boolean).join('.');
        return `${path || '<root>'}: ${issue.message}`;
    });
}
