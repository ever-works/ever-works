import { z } from 'zod/v4';
import {
    APP_SPEC_BUILD_STRATEGIES,
    APP_SPEC_COMPONENT_ROLES,
    APP_SPEC_CRON_CONCURRENCIES,
    APP_SPEC_DOMAIN_CHANGES,
    APP_SPEC_ENV_PHASES,
    APP_SPEC_EXTENSION_KEY_PREFIX,
    APP_SPEC_GENERATE_ALPHABETS,
    APP_SPEC_GENERATE_KINDS,
    APP_SPEC_GENERATE_ROTATIONS,
    APP_SPEC_HTTP_AUTH_SCHEMES,
    APP_SPEC_HTTP_METHODS,
    APP_SPEC_JOB_WHENS,
    APP_SPEC_KEYPAIR_FORMATS,
    APP_SPEC_KEYPAIR_TYPES,
    APP_SPEC_MAX_PROTECTED_PATHS,
    APP_SPEC_MAX_REQUIRE_HUMAN_MERGE_PATHS,
    APP_SPEC_POSTGRES_VERSIONS,
    APP_SPEC_REDIS_MAXMEMORY_POLICIES,
    APP_SPEC_REDIS_VERSIONS,
    APP_SPEC_SMOKE_HTTP_METHODS,
    APP_SPEC_SMOKE_WHENS,
    APP_SPEC_SOURCE_RELATIONS,
    APP_SPEC_UPSTREAM_SYNC_MODES,
    LICENSE_CLASSES,
    LICENSE_SOURCES,
} from '@ever-works/contracts';

/**
 * The App spec — `schema.md` §5–§20 as a zod v4 **structural** schema.
 *
 * Owning epic: **APW-03** (task T3). Plan: `plan.md` §2.2:123-125 — "zod v4
 * `z.strictObject` for every object in `schema.md` §5–§20, the enums, bounds and
 * defaults (defaults documented via `.describe()`; never materialised into the
 * file). Exported as `appSpecSchema` and registered as `KIND_SPEC_SCHEMAS.app`."
 *
 * ## What this module is, and what it deliberately is not
 *
 * It is the **structural** layer of the App spec validator: shape, closed
 * vocabularies, bounds and the documented defaults. The layers above it are
 * separate modules and must not be duplicated here:
 *
 * | Layer                                              | Module                 | Task |
 * | -------------------------------------------------- | ---------------------- | ---- |
 * | Reference grammar, resolution, secrecy/phase (§21) | `app-spec.refs.ts`     | T4   |
 * | Cross-field rules R1–R27 (§22)                     | `app-spec.rules.ts`    | T5   |
 * | Positions, issue codes, messages, modes            | `app-spec.validate.ts` | T6   |
 * | Published JSON Schema (§25)                        | `emit-*-json-schema.ts`| T8   |
 *
 * **No refinements.** Every constraint here is expressible in JSON Schema, so
 * the published artifact (T8) enforces exactly what the runtime does. Nothing in
 * this file calls `.refine()`, `.superRefine()` or `.check()`: zod silently drops
 * those from `z.toJSONSchema()` output, which would leave an editor accepting a
 * document the platform refuses. It would also make the schema itself — rather
 * than the rule layer — refuse the documents `schema.md` §22 exists to report:
 * the caller runs R1–R27 over a best-effort copy whenever the document *parses*,
 * and every extra structural failure removes a document from that path.
 *
 * **Defaults are documented, never materialised.** `schema.md` §0: "The value the
 * platform uses when the key is absent. Defaults are never written back into the
 * file." So the default of every field appears in its `.describe()` text and in
 * no `.default()` call — a `.default()` would also change
 * `z.input<typeof appSpecSchema>`, which is the type the mutual-assignability test
 * against `AppSpec` (T1) compares.
 *
 * **Optionality follows the hand-written contract, not intuition.** `AppSpec`
 * (`packages/contracts/src/apps/app-spec.types.ts`) marks a field optional
 * exactly when §5–§20 does not mark it required, and its header explains why the
 * *conditional* requirements (`source` in `data-repository` mode, `build.strategy`
 * with components, `port` for `web`, `image` with `strategy: image`) belong to
 * the rules of §22 — a type that required them could not describe the document
 * that reports the problem. This schema mirrors that contract field for field,
 * optionality included; a type-level test in
 * `__tests__/app-spec.schema.spec.ts` fails if the two ever drift.
 *
 * **`x-` keys are stripped before parsing, not accepted by it.** §2:74-75 allows
 * an `x-` key at any depth inside `spec`, preserved and ignored. The strict
 * objects below do not know that exception — they report `unrecognized_keys` —
 * and the pipeline instead removes the extension keys from a **copy** first
 * (plan §2.2:137-138, `docs/agent-services/works-yml-schema.md`): the document
 * itself is never touched, the raw file round-trips, and the App spec tab can
 * show what the author wrote. {@link stripExtensionKeys} is that step.
 */

// ---------------------------------------------------------------------------
// Version and validation modes (schema.md §1, §3)
// ---------------------------------------------------------------------------

/**
 * The lowest `spec.appSpecVersion` a document may declare — 1
 * (schema.md §1:65 "1–1000").
 */
export const APP_SPEC_VERSION_MIN = 1;

/**
 * The highest `spec.appSpecVersion` this schema accepts structurally — 1000
 * (schema.md §1:65).
 *
 * A value **inside** this bound but above {@link APP_SPEC_VERSION} (`1`, the
 * version this build understands, from the T1 contract) is not refused: §2:76-77
 * turns `unknown_field` into the warning `unknown_field_newer_version` and every
 * other rule still applies. That downgrade is the validator's (T6); the schema's
 * part is to accept the version and hand it on, which is why the value is
 * readable from the parse result.
 */
export const APP_SPEC_VERSION_MAX = 1000;

/**
 * The two modes of `schema.md` §3 — where validation runs and how strict it is.
 *
 * `data-repository` is the platform's own path: a Work's Work Repository
 * (§3:87) and draft text through the `validate` API (§3:88) both run structure,
 * §21 and §22, and `source` is required (§4:99 "**required**
 * (`data-repository`)").
 *
 * `blueprint` is Apps catalog CI validating a Blueprint repository's own file
 * (§3:89). **`source` and `blueprint` are allowed and expected there** — the
 * row was corrected on 2026-09-17: it used to forbid them with
 * `blueprint_mode_forbidden_key`, which no APW-13 Blueprint could satisfy,
 * because a Blueprint's own file becomes the App Work's spec with both keys
 * present. The code stays in §23's list for the structural cases §2 describes
 * but is **no longer emitted for those two keys**, so a Blueprint repository's
 * file is validatable with exactly the rules the platform runs. `license` is
 * optional in this mode.
 */
export const APP_SPEC_VALIDATION_MODES = ['data-repository', 'blueprint'] as const;

/** Union derived from {@link APP_SPEC_VALIDATION_MODES}. */
export type AppSpecValidationMode = (typeof APP_SPEC_VALIDATION_MODES)[number];

/**
 * The keys `blueprint` mode **allows and expects** (schema.md §3:89, corrected
 * 2026-09-17).
 *
 * Named here, in the schema module, because that is where the rest of the
 * structure lives: a mode that forbade these two would refuse every APW-13
 * Blueprint's own file. `blueprint_mode_forbidden_key` is therefore never
 * emitted for either key, in any mode.
 */
export const APP_SPEC_BLUEPRINT_MODE_ALLOWED_KEYS = ['source', 'blueprint'] as const;

/** Union derived from {@link APP_SPEC_BLUEPRINT_MODE_ALLOWED_KEYS}. */
export type AppSpecBlueprintModeAllowedKey = (typeof APP_SPEC_BLUEPRINT_MODE_ALLOWED_KEYS)[number];

// ---------------------------------------------------------------------------
// §0 notation — the named scalar types §5–§20 refer to
// ---------------------------------------------------------------------------

/** §0 `Name`: `^[a-z]([-a-z0-9]{0,30}[a-z0-9])?$` — a DNS label of 1–32 characters. */
export const APP_SPEC_NAME_PATTERN = /^[a-z](?:[-a-z0-9]{0,30}[a-z0-9])?$/;

/** §0 `EnvName`: `^[A-Z_][A-Z0-9_]{0,127}$`. */
export const APP_SPEC_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;

/**
 * §0 `RelPath`: 1–255 characters, repository-relative — no leading `/`, no `\`,
 * no `..` segment, not under `.git/`.
 *
 * The four negations are look-aheads so that they are expressible as one JSON
 * Schema `pattern`; a `.refine()` would not survive `z.toJSONSchema()`.
 */
export const APP_SPEC_REL_PATH_PATTERN =
    /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)\.git(?:\/|$))[\s\S]{1,255}$/;

/** §0 `Glob`: a `RelPath` that may contain `*`, `**`, `?`; 1–200 characters. */
export const APP_SPEC_GLOB_PATTERN =
    /^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)\.git(?:\/|$))[\s\S]{1,200}$/;

/** §0 `HttpPath`: `^/[^\s]{0,511}$` — an in-container path, never a URL. */
export const APP_SPEC_HTTP_PATH_PATTERN = /^\/[^\s]{0,511}$/;

/**
 * §0 `CpuQuantity`: millicores (`250m`) or cores (`2`, `0.5`).
 *
 * The **shape** is here; the range (10m–64000m, or 0.01–64 cores) is a value
 * bound no JSON Schema `pattern` expresses honestly, so it stays with the layer
 * that reports `out_of_range` — see this module's header on refinements.
 */
export const APP_SPEC_CPU_QUANTITY_PATTERN = /^(?:\d+m|\d+(?:\.\d+)?)$/;

/**
 * §0 `MemQuantity` / `StorageQuantity`: an integer followed by `Mi` or `Gi`
 * (ranges: `64Mi`–`256Gi`, `100Mi`–`500Gi`; `build.resources.memory` is
 * `1Gi`–`64Gi`). Shape only, for the reason given on
 * {@link APP_SPEC_CPU_QUANTITY_PATTERN}.
 */
export const APP_SPEC_BYTE_QUANTITY_PATTERN = /^\d+(?:Mi|Gi)$/;

/**
 * §0 `ImageRef`: `registry/path[:tag][@sha256:<64 hex>]`, ≤ 512 characters.
 *
 * Covers the three spellings the App spec actually uses — `postgres:16`,
 * `registry.example.com:5000/org/app:1.2.3`, and a digest-pinned
 * `ghcr.io/org/app@sha256:<64 hex>` (schema.md §24.2) — and nothing else.
 */
export const APP_SPEC_IMAGE_REF_PATTERN =
    /^(?:[A-Za-z0-9][A-Za-z0-9._-]*(?::\d+)?\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9._-]+)?(?:@sha256:[0-9a-f]{64})?$/;

/** §0 `ImageRef` is capped at 512 characters as well as shaped. */
export const APP_SPEC_IMAGE_REF_MAX_LENGTH = 512;

/**
 * §0 `Git ref name`, as §5:126 and §19:400 bound it: 1–255 characters, not
 * ending in `.lock`, containing neither `..` nor `//`.
 *
 * Only those three rules are encoded: git's longer list (no leading or trailing
 * `/`, no `@{`, no control characters) is not what §5 or §19 says, and adding it
 * here would refuse documents the spec accepts.
 */
export const APP_SPEC_GIT_REF_PATTERN = /^(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[\s\S]{1,255}$/;

/** §0 `Cron` — five fields, UTC. §14:339 reports an unparsable one as `cron_invalid` (a rule-layer check). */
export const APP_SPEC_CRON_FIELD_PATTERN = /^\S+(?:\s+\S+){4}$/;

/** `Name` — §0's DNS label, used by components, jobs, cron, smoke, checks and build services. */
const name = z
    .string()
    .regex(APP_SPEC_NAME_PATTERN)
    .describe(
        'Name (schema.md §0): a DNS label of 1–32 characters, lowercase, digits and dashes only.',
    );

/** `EnvName` — §0's environment-variable name. */
const envName = z
    .string()
    .regex(APP_SPEC_ENV_NAME_PATTERN)
    .describe('EnvName (schema.md §0): ^[A-Z_][A-Z0-9_]{0,127}$.');

/** `RelPath` — §0's repository-relative path. */
const relPath = z
    .string()
    .regex(APP_SPEC_REL_PATH_PATTERN)
    .describe(
        'RelPath (schema.md §0): 1–255 characters, relative, no `..` segment, not under `.git/`.',
    );

/** `Glob` — §0's `RelPath` that may contain `*`, `**` and `?`. */
const glob = z
    .string()
    .regex(APP_SPEC_GLOB_PATTERN)
    .describe(
        'Glob (schema.md §0): a RelPath of 1–200 characters that may contain `*`, `**` or `?`.',
    );

/** `HttpPath` — §0's in-container path. */
const httpPath = z
    .string()
    .regex(APP_SPEC_HTTP_PATH_PATTERN)
    .describe(
        'HttpPath (schema.md §0): ^/[^\\s]{0,511}$ — a path inside the container, never a URL.',
    );

/** `CpuQuantity` — §0: millicores or cores. */
const cpuQuantity = z
    .string()
    .regex(APP_SPEC_CPU_QUANTITY_PATTERN, 'must be millicores (250m) or cores (2, 0.5)')
    .describe('CpuQuantity (schema.md §0): millicores `250m` or cores `2` / `0.5`.');

/** `MemQuantity` / `StorageQuantity` — §0: an integer followed by `Mi` or `Gi`. */
const byteQuantity = z
    .string()
    .regex(APP_SPEC_BYTE_QUANTITY_PATTERN, 'must be an integer followed by Mi or Gi')
    .describe('A byte quantity (schema.md §0): an integer followed by `Mi` or `Gi`.');

/** `ImageRef` — §0: a registry reference, optionally tag- and digest-pinned. */
const imageRef = z
    .string()
    .max(APP_SPEC_IMAGE_REF_MAX_LENGTH)
    .regex(APP_SPEC_IMAGE_REF_PATTERN)
    .describe('ImageRef (schema.md §0): registry/path[:tag][@sha256:<64 hex>], ≤ 512 characters.');

/** `Git ref name` — §5:125-126, §19:400. */
const gitRef = z
    .string()
    .regex(APP_SPEC_GIT_REF_PATTERN)
    .describe(
        'A git ref name (schema.md §5): 1–255 characters, no `..`, no `//`, not ending in `.lock`.',
    );

/**
 * §13:322-324 — the Dockerfile stage selector, shared by `build.target` (§9:173)
 * and `components[].target` (§10:198).
 */
const dockerTarget = z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .describe('A Dockerfile stage name (§9:173): ^[A-Za-z0-9._-]{1,64}$.');

/** §13:322 / §14:341 — a command vector, ≤ 20 items of ≤ 1000 characters each. */
const commandVector = z
    .array(z.string().max(1000))
    .max(20)
    .describe('A command vector (§13:322): at most 20 items, each at most 1000 characters.');

/** §13:328 / §16:365 — the status codes a request expects, 1–10 of them, 100–599. */
const expectedStatuses = z
    .array(z.number().int().min(100).max(599))
    .min(1)
    .max(10)
    .describe('Expected status codes (§13:328): 1–10 codes, each 100–599.');

// ---------------------------------------------------------------------------
// §5 `source` and its `upstream`
// ---------------------------------------------------------------------------

/**
 * §5:119-126 — the repository the fork or private copy follows.
 *
 * `repo` is required **inside the object**; the object itself is optional and,
 * for `relation: link`, forbidden (`upstream_forbidden_for_link`, R13) — a
 * cross-field rule, so it is not enforced here (§5:124, §22 R13).
 */
export const appSpecUpstreamSchema = z.strictObject({
    repo: z
        .string()
        .regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/)
        .describe(
            'The upstream repository, `owner/repo` (§5:124); required unless `relation` is `link`.',
        ),
    defaultBranch: gitRef
        .optional()
        .describe(
            'The upstream branch to follow (§5:125); default: the upstream default at creation.',
        ),
});

/**
 * §5:119-129 — where the App Work's repository came from.
 *
 * APW-01 writes this block at creation and APW-03's apply job writes it with the
 * rest of the spec on the Blueprint path (R-4). A server-only rule compares
 * `relation` with the relation recorded when the App Work was created
 * (`source_relation_mismatch`, §5:128-129).
 */
export const appSpecSourceSchema = z.strictObject({
    relation: z
        .enum(APP_SPEC_SOURCE_RELATIONS)
        .describe(
            'How the App Work relates to its repository (§5:123): fork · private-copy · link. Required.',
        ),
    upstream: appSpecUpstreamSchema
        .optional()
        .describe('The repository followed (§5:124); forbidden when `relation` is `link` (R13).'),
    branch: gitRef
        .optional()
        .describe(
            'The branch built and deployed (§5:126); default: the Work Repository default branch.',
        ),
});

// ---------------------------------------------------------------------------
// §6 `blueprint`
// ---------------------------------------------------------------------------

/**
 * §6:131-142 — written by the platform when an App Blueprint is applied,
 * informational afterwards.
 *
 * All four fields are required. `repo` outside `ever-works/` is
 * `blueprint_repo_outside_org`, and an `id` the Apps catalog does not list is the
 * **server-only** warning `blueprint_unknown` (§6:142) — neither is structural.
 */
export const appSpecBlueprintSchema = z.strictObject({
    id: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
        .describe('The Blueprint id (§6:137): ^[a-z0-9][a-z0-9-]{0,63}$. Required.'),
    version: z
        .string()
        .regex(/^\d+\.\d+\.\d+$/)
        .describe(
            'The Blueprint version (§6:138): a semantic version `MAJOR.MINOR.PATCH`. Required.',
        ),
    repo: z
        .string()
        .regex(/^ever-works\/[a-z0-9-]+$/)
        .describe('The Blueprint repository (§6:139): ^ever-works/[a-z0-9-]+$. Required.'),
    sha: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .describe('The pinned Blueprint commit (§6:140): 40 lowercase hex characters. Required.'),
});

// ---------------------------------------------------------------------------
// §7 `license`
// ---------------------------------------------------------------------------

/**
 * §7:144-157 — **informational**: the licence gate classifies from detection,
 * never from this block.
 *
 * A declared `spdx` or `class` that differs from detection is the server-only
 * warning `license_declared_mismatch` (R24), and R27 requires `sourceOfferUrl`
 * whenever the Work Repository is not public — both rule-layer.
 */
export const appSpecLicenseSchema = z.strictObject({
    spdx: z
        .string()
        .max(200)
        .optional()
        .describe(
            'An SPDX expression ≤ 200 characters (§7:150): `MIT`, `AGPL-3.0-only`, `MIT OR Apache-2.0`.',
        ),
    class: z
        .enum(LICENSE_CLASSES)
        .optional()
        .describe('The declared licence class (§7:151): green · amber · red · unknown.'),
    source: z
        .enum(LICENSE_SOURCES)
        .optional()
        .describe('Where the declaration came from (§7:152): detected · blueprint · user.'),
    notice: z
        .string()
        .max(500)
        .optional()
        .describe('Trademark / attribution notice shown with the app, ≤ 500 characters (§7:153).'),
    sourceOfferUrl: z
        .string()
        .max(500)
        .regex(/^https:\/\//, 'must be an https:// URL')
        .optional()
        .describe(
            'Where network users obtain the source when the Work Repository is private (§7:154, R27).',
        ),
});

// ---------------------------------------------------------------------------
// §8 `display`
// ---------------------------------------------------------------------------

/** §8:159-164 — the protected-path list is APW-08's D13 guard; a **removal** from it is reported by `diffGuardedSpecBlocks` (CONTRACTS §2A). */
export const appSpecDisplaySchema = z.strictObject({
    name: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe('How the app is displayed, 1–80 characters (§8:163); default: the Work name.'),
    protectedPaths: z
        .array(glob)
        .max(APP_SPEC_MAX_PROTECTED_PATHS)
        .optional()
        .describe(
            `Paths agents may not change (§8:164), at most ${APP_SPEC_MAX_PROTECTED_PATHS} globs; default: [].`,
        ),
});

// ---------------------------------------------------------------------------
// §9 `build`
// ---------------------------------------------------------------------------

/** §9:175 — one build argument: exactly one of `value` / `fromEnv` (R10/R11 report the rest). */
export const appSpecBuildArgSchema = z.strictObject({
    name: envName.describe('The build argument name (§9:175). Required.'),
    value: z
        .string()
        .max(1000)
        .optional()
        .describe(
            'A literal build-argument value ≤ 1000 characters (§9:175); never a secret (R10).',
        ),
    fromEnv: envName
        .optional()
        .describe(
            'Names an `env` entry that must be `build` or `both` (§9:175); a secret one only warns (R11).',
        ),
});

/** §9:176 — one `env` entry of an ephemeral build service. §9 states no bound for either field. */
export const appSpecBuildServiceEnvEntrySchema = z.strictObject({
    name: z.string().describe('The variable name of a build service’s environment entry (§9:176).'),
    value: z.string().describe('The value of a build service’s environment entry (§9:176).'),
});

/** §9:176 — one ephemeral, build-only service: at most 5, each with at most 20 env entries. */
export const appSpecBuildServiceSchema = z.strictObject({
    name: name.describe('The service name (§9:176). Required.'),
    image: imageRef.describe('The service image (§9:176). Required.'),
    port: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .optional()
        .describe('The service port, 1–65535 (§9:176).'),
    env: z
        .array(appSpecBuildServiceEnvEntrySchema)
        .max(20)
        .optional()
        .describe('At most 20 environment entries for the service (§9:176).'),
});

/** §9:177-179 — the **build runner's** resources, not the app's. */
export const appSpecBuildResourcesSchema = z.strictObject({
    cpu: z
        .number()
        .min(1)
        .max(16)
        .optional()
        .describe('Build-runner CPU cores, a number 1–16 (§9:177); default: 2.'),
    memory: byteQuantity
        .optional()
        .describe('Build-runner memory, `1Gi`–`64Gi` (§9:178); default: `7Gi`.'),
    timeoutMinutes: z
        .number()
        .int()
        .min(5)
        .max(180)
        .optional()
        .describe('Build timeout in minutes, 5–180 (§9:179); default: 60.'),
});

/**
 * §9:166-186 — how the image is produced (APW-05 consumes it).
 *
 * `strategy` is deliberately **optional here**: §9:170 makes it required only
 * when `components` is non-empty and defaulted to `none` when it is empty, and
 * R2 reports both directions (`strategy_requires_components` /
 * `components_require_strategy`). The vocabulary is `dockerfile` · `image` ·
 * `auto` · `none` — **no builder name** (R-13): which plugin implements `auto` is
 * the build plugin's choice and is never named in the App spec (§9:181-186).
 */
export const appSpecBuildSchema = z.strictObject({
    strategy: z
        .enum(APP_SPEC_BUILD_STRATEGIES)
        .optional()
        .describe(
            'How the image is produced (§9:170): dockerfile · image · auto · none. ' +
                'Required when `components` is non-empty; `none` when it is empty. No builder name (R-13).',
        ),
    dockerfile: relPath
        .optional()
        .describe(
            'The Dockerfile path, only with `strategy: dockerfile` (§9:171); default: `Dockerfile`.',
        ),
    context: relPath
        .optional()
        .describe('The build context, only with `dockerfile` or `auto` (§9:172); default: `.`.'),
    target: dockerTarget
        .optional()
        .describe('The Dockerfile target stage, only with `strategy: dockerfile` (§9:173).'),
    image: imageRef
        .optional()
        .describe(
            'The prebuilt image, required with `strategy: image` (§9:174); a tag-only reference warns (R19).',
        ),
    args: z
        .array(appSpecBuildArgSchema)
        .max(50)
        .optional()
        .describe('At most 50 build arguments (§9:175); default: []. Never literal secrets (R10).'),
    services: z
        .array(appSpecBuildServiceSchema)
        .max(5)
        .optional()
        .describe('At most 5 ephemeral build-only services (§9:176); default: [].'),
    resources: appSpecBuildResourcesSchema
        .optional()
        .describe(
            'The build runner’s resources (§9:177-179); defaults: cpu 2, memory 7Gi, timeout 60.',
        ),
});

// ---------------------------------------------------------------------------
// §10 `components`
// ---------------------------------------------------------------------------

/**
 * §10:210-213 — one probe.
 *
 * **Exactly one of `http` / `tcp`** is a §10 requirement with no code of its own
 * in §23, so it is not enforced structurally: the two keys are modelled as they
 * are declared and the rule layer decides what to report. The four timings are
 * optional because §0 documents them as defaults the platform applies and never
 * writes back (10 / 5 / 0 / 3, with `startup.failureThreshold` 30).
 */
export const appSpecProbeSchema = z.strictObject({
    http: httpPath.optional().describe('An in-container HTTP path (§10:210).'),
    tcp: z.literal(true).optional().describe('A TCP connect probe (§10:210).'),
    periodSeconds: z
        .number()
        .int()
        .min(1)
        .max(300)
        .optional()
        .describe('1–300 (§10:210); default: 10.'),
    timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe('1–60 (§10:210); default: 5.'),
    initialDelaySeconds: z
        .number()
        .int()
        .min(0)
        .max(600)
        .optional()
        .describe('0–600 (§10:210); default: 0.'),
    failureThreshold: z
        .number()
        .int()
        .min(1)
        .max(120)
        .optional()
        .describe('1–120 (§10:211); default: 3, or 30 for `startup`.'),
});

/** §10:203 — the three probes a component may declare; `readiness` defaults to `{ tcp: true }` for a `web` component. */
export const appSpecProbesSchema = z.strictObject({
    startup: appSpecProbeSchema.optional().describe('The startup probe (§10:203).'),
    readiness: appSpecProbeSchema.optional().describe('The readiness probe (§10:203).'),
    liveness: appSpecProbeSchema.optional().describe('The liveness probe (§10:203).'),
});

/**
 * §10:204-207 — the app container's requests and limits.
 *
 * `memoryLimit ≥ memory` and `cpuLimit ≥ cpu` are R17 (`limit_below_request`),
 * and `memoryLimit` defaults to `2 × memory` — a relative default, which is why
 * it is not a value here.
 */
export const appSpecResourcesSchema = z.strictObject({
    cpu: cpuQuantity.optional().describe('The CPU request (§10:204); default: `250m`.'),
    memory: byteQuantity.optional().describe('The memory request (§10:205); default: `512Mi`.'),
    cpuLimit: cpuQuantity.optional().describe('The CPU limit, ≥ `cpu` (§10:206, R17).'),
    memoryLimit: byteQuantity
        .optional()
        .describe('The memory limit, ≥ `memory` (§10:207, R17); default: `2 × memory`.'),
});

/** §10:208 — one volume: unique names and paths are R4/R22 territory, not structure. */
export const appSpecVolumeSchema = z.strictObject({
    name: name.describe('The volume name (§10:208). Required.'),
    path: z
        .string()
        .regex(/^\/[\s\S]{0,254}$/)
        .describe('An absolute mount path of at most 255 characters (§10:208). Required.'),
    size: byteQuantity.describe('The volume size, `100Mi`–`500Gi` (§10:208). Required.'),
    backup: z
        .boolean()
        .optional()
        .describe('Whether the volume is backed up (§10:208); default: true.'),
});

/**
 * §10:188-213 — one component (APW-06 renders it).
 *
 * `port` is required for `web` and forbidden for `worker`
 * (`web_component_needs_port` / `worker_port_forbidden`, R1) — conditional, so
 * optional here. `runAsUser` is the APW06-G26 addition of 2026-09-17: an image
 * whose `USER` is a **name** cannot satisfy `runAsNonRoot`, and without this
 * field the App would be undeployable on both targets. It is passed through
 * verbatim, never derived, and omitting it renders no field at all.
 */
export const appSpecComponentSchema = z.strictObject({
    name: name.describe('A DNS-label name, unique among components (§10:194, R4). Required.'),
    role: z
        .enum(APP_SPEC_COMPONENT_ROLES)
        .describe('web (Service + Ingress) or worker (§10:195). Required.'),
    command: commandVector
        .optional()
        .describe(
            'Image entrypoint override, ≤ 20 items × 1000 characters (§10:196); default: the image entrypoint.',
        ),
    args: z
        .array(z.string().max(1000))
        .max(50)
        .optional()
        .describe(
            'Image cmd override, ≤ 50 items × 1000 characters (§10:197); default: the image cmd.',
        ),
    target: dockerTarget
        .optional()
        .describe('Dockerfile stage override (§10:198); default: `build.target`.'),
    port: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .optional()
        .describe(
            'The container port, 1–65535 (§10:199). Required for `web` (R1), forbidden for `worker`.',
        ),
    replicas: z
        .number()
        .int()
        .min(0)
        .max(10)
        .optional()
        .describe('Replicas, 0–10 (§10:200); default: 1.'),
    writableRootFilesystem: z
        .boolean()
        .optional()
        .describe('Whether the root filesystem is writable (§10:201); default: false.'),
    runAsUser: z
        .number()
        .int()
        .min(1)
        .max(4294967294)
        .optional()
        .describe(
            'The numeric uid the container runs as, 1–4294967294 (§10:202, APW06-G26); ' +
                'default: absent — the image’s own user.',
        ),
    probes: appSpecProbesSchema
        .optional()
        .describe('The component’s probes (§10:203); `web` defaults to a TCP readiness probe.'),
    resources: appSpecResourcesSchema
        .optional()
        .describe('The container’s resources (§10:204-207).'),
    volumes: z
        .array(appSpecVolumeSchema)
        .max(5)
        .optional()
        .describe(
            'At most 5 volumes (§10:208); default: []. A component with volumes is limited to one replica (R18).',
        ),
});

// ---------------------------------------------------------------------------
// §11 `dependencies`
// ---------------------------------------------------------------------------

/** §11:219-221 — the managed Postgres. The outputs a `from:` may reference are `APP_DEPENDENCY_OUTPUTS` (APW-07). */
export const appSpecPostgresSchema = z.strictObject({
    version: z
        .enum(APP_SPEC_POSTGRES_VERSIONS)
        .optional()
        .describe('The Postgres major (§11:219): "14" · "15" · "16" · "17"; default: "16".'),
    directUrl: z
        .boolean()
        .optional()
        .describe('Also provide a non-pooled URL (§11:220); default: false.'),
    extensions: z
        .array(z.string().regex(/^[a-z0-9_]{1,63}$/))
        .max(10)
        .optional()
        .describe(
            'At most 10 Postgres extensions (§11:221); default: []. Availability warns `extension_unavailable`.',
        ),
});

/** §11:222-224 — the managed Redis. */
export const appSpecRedisSchema = z.strictObject({
    version: z
        .enum(APP_SPEC_REDIS_VERSIONS)
        .optional()
        .describe('The Redis major (§11:222): "7"; default: "7".'),
    maxmemoryPolicy: z
        .enum(APP_SPEC_REDIS_MAXMEMORY_POLICIES)
        .optional()
        .describe('The eviction policy (§11:223); default: `noeviction`.'),
    persistence: z
        .boolean()
        .optional()
        .describe('Whether Redis persists (§11:224); default: false.'),
});

/** §11:225-226 — object storage. `publicBuckets` ⊆ `buckets` is `public_bucket_undeclared`, a rule. */
export const appSpecObjectStorageSchema = z.strictObject({
    buckets: z
        .array(name)
        .min(1)
        .max(10)
        .describe('The buckets to create, 1–10 unique names (§11:225). Required.'),
    publicBuckets: z
        .array(name)
        .optional()
        .describe(
            'Buckets that are publicly readable, a subset of `buckets` (§11:226); default: [].',
        ),
});

/** §11:227 — `required: true` blocks the deploy until SMTP is configured (APW-07). */
export const appSpecSmtpSchema = z.strictObject({
    required: z
        .boolean()
        .optional()
        .describe('Whether SMTP is required before deploying (§11:227); default: false.'),
});

/** §11:215-237 — the managed services the app needs (APW-07 provisions, APW-06 wires their outputs in). */
export const appSpecDependenciesSchema = z.strictObject({
    postgres: appSpecPostgresSchema.optional().describe('Managed Postgres (§11:219-221).'),
    redis: appSpecRedisSchema.optional().describe('Managed Redis (§11:222-224).'),
    objectStorage: appSpecObjectStorageSchema.optional().describe('Object storage (§11:225-226).'),
    smtp: appSpecSmtpSchema.optional().describe('Managed SMTP (§11:227).'),
});

// ---------------------------------------------------------------------------
// §12 `env[]`
// ---------------------------------------------------------------------------

/**
 * §12:268-283 — `generate.keypair` (**R-11**).
 *
 * `base64url-raw` only with `ed25519` or `ec-p256` (`keypair_format_unsupported`,
 * R25) and `passwordEnv` present exactly when `format: pkcs12`, naming another
 * generated secret entry (`keypair_password_invalid`, R26) — both rules. The
 * private half is the entry itself; the public half is exposed as
 * `<NAME>_PUBLIC` only (§12:276-283).
 */
export const appSpecEnvKeypairSchema = z.strictObject({
    type: z
        .enum(APP_SPEC_KEYPAIR_TYPES)
        .optional()
        .describe(
            'The key type (§12:272): ed25519 · ec-p256 · rsa-2048 · rsa-4096; default: `ed25519`.',
        ),
    format: z
        .enum(APP_SPEC_KEYPAIR_FORMATS)
        .optional()
        .describe(
            'The storage format (§12:273, R-11): pem · base64url-raw · pkcs12; default: `pem`.',
        ),
    passwordEnv: envName
        .optional()
        .describe('Required with `format: pkcs12`, forbidden otherwise (§12:274, R26).'),
});

/**
 * §12:257-266 — how a generated value is produced.
 *
 * A generated entry implies `secret: true` (`generated_not_secret` when it says
 * otherwise), and `bytes` belongs to `base64`/`hex`, `length` and `alphabet` to
 * `chars`, `keypair` to `keypair` — cross-field, so R9 and §12's generated-length
 * table (R9: `hex` = 2 × bytes, `base64` = 4 × ceil(bytes / 3), `chars` = length,
 * `uuid` = 36, a `base64url-raw` key pair = 43) stay in the rule layer.
 */
export const appSpecEnvGenerateSchema = z.strictObject({
    kind: z
        .enum(APP_SPEC_GENERATE_KINDS)
        .describe('The generator (§12:261): base64 · hex · chars · uuid · keypair. Required.'),
    bytes: z
        .number()
        .int()
        .min(16)
        .max(128)
        .optional()
        .describe('16–128, `base64` and `hex` only (§12:262); default: 32.'),
    length: z
        .number()
        .int()
        .min(16)
        .max(256)
        .optional()
        .describe('16–256, `chars` only (§12:263); default: 32.'),
    alphabet: z
        .enum(APP_SPEC_GENERATE_ALPHABETS)
        .optional()
        .describe('The alphabet, `chars` only (§12:264); default: `alnum`.'),
    keypair: appSpecEnvKeypairSchema
        .optional()
        .describe('Key-pair settings, `keypair` only (§12:265, R-11).'),
    rotate: z
        .enum(APP_SPEC_GENERATE_ROTATIONS)
        .optional()
        .describe(
            'When the value is replaced (§12:266): `never` is the only value in appSpecVersion 1.',
        ),
});

/**
 * §12:254 — the generated-value checks.
 *
 * `pattern` is **RE2** syntax: no back-references and no look-around, or
 * `pattern_unsupported`. That is a property of the pattern language, so it is
 * reported by the layer that parses it, not here.
 */
export const appSpecEnvValidateSchema = z.strictObject({
    length: z
        .number()
        .int()
        .min(1)
        .max(65536)
        .optional()
        .describe('The exact generated length, 1–65536 (§12:254, R9).'),
    minLength: z
        .number()
        .int()
        .min(1)
        .max(65536)
        .optional()
        .describe('The minimum length, ≤ 65536 (§12:254, R9).'),
    maxLength: z
        .number()
        .int()
        .min(1)
        .max(65536)
        .optional()
        .describe('The maximum length, ≤ 65536 (§12:254, R9).'),
    pattern: z
        .string()
        .max(500)
        .optional()
        .describe(
            'An RE2 pattern of at most 500 characters (§12:254); look-around is `pattern_unsupported`.',
        ),
});

/** §12:255 — the question asked at setup; the answer is never stored in this block (APW-01 FR-55). */
export const appSpecEnvPromptSchema = z.strictObject({
    description: z
        .string()
        .min(1)
        .max(300)
        .describe('The question, 1–300 characters (§12:255). Required.'),
    required: z
        .boolean()
        .optional()
        .describe('Whether the answer is required (§12:255); default: true.'),
    example: z
        .string()
        .max(200)
        .optional()
        .describe(
            'An example answer ≤ 200 characters (§12:255); secret-scanned — a match is `prompt_example_secret`.',
        ),
    group: z.string().max(40).optional().describe('The prompt group, ≤ 40 characters (§12:255).'),
});

/**
 * §12:239-311 — one `env` entry (APW-07 generates and stores the values,
 * APW-06 injects them).
 *
 * **Exactly one value source** — `value`, `from`, `template`, `generate` or
 * `prompt` — is `env_source_count` (R7); `value` on a `secret: true` entry is
 * `literal_secret_value` (R8); secrecy and phase propagate through
 * `from`/`template` (R6); `EVER_WORKS_*` is reserved (R23); and the implicit
 * `<NAME>_PUBLIC` of a key pair counts towards `duplicate_name` (R4). Every one
 * of those is a rule, not a shape.
 */
export const appSpecEnvEntrySchema = z.strictObject({
    name: envName.describe('The variable name (§12:246). Required.'),
    secret: z
        .boolean()
        .optional()
        .describe(
            'Stored encrypted, never logged or returned (§12:247, Constitution VII); default: false.',
        ),
    phase: z
        .enum(APP_SPEC_ENV_PHASES)
        .optional()
        .describe('When the value exists (§12:248): runtime · build · both; default: `runtime`.'),
    description: z
        .string()
        .max(300)
        .optional()
        .describe('What the value is for, ≤ 300 characters (§12:249).'),
    value: z
        .string()
        .max(4096)
        .optional()
        .describe(
            'A literal value ≤ 4096 characters (§12:250); forbidden when `secret: true` (R8).',
        ),
    from: z
        .string()
        .optional()
        .describe('A §21 reference (§12:251), resolved by `app-spec.refs.ts` (T4).'),
    template: z
        .string()
        .max(2048)
        .optional()
        .describe(
            'A ≤ 2048-character template over the same references plus `env.<NAME>` (§12:252).',
        ),
    generate: appSpecEnvGenerateSchema
        .optional()
        .describe('Generate the value (§12:253); implies `secret: true`.'),
    validate: appSpecEnvValidateSchema
        .optional()
        .describe('Checks applied to the value (§12:254, R9).'),
    prompt: appSpecEnvPromptSchema.optional().describe('Ask for the value at setup (§12:255).'),
});

// ---------------------------------------------------------------------------
// §13 `jobs[]`, §14 `cron[]` and the `http` block they share
// ---------------------------------------------------------------------------

/**
 * §13:323-328 — the `http` block of a job or a cron entry (§14:341: "`http` as in
 * §13, including `authEnv` and `authScheme`").
 *
 * `path` is sent to the component's port **inside the cluster**, never through
 * the public URL; `authEnv` must name a `secret: true` entry
 * (`auth_env_not_secret`, R15). `body` is a JSON document of at most 16 KiB
 * serialized whose string leaves may hold `{{…}}` placeholders — a size bound no
 * structural keyword expresses, so it is the validator's.
 */
export const appSpecHttpRequestSchema = z.strictObject({
    method: z
        .enum(APP_SPEC_HTTP_METHODS)
        .optional()
        .describe('GET · POST · PUT · PATCH · DELETE (§13:323); default: `POST`.'),
    path: httpPath.describe('The in-cluster request path (§13:324). Required.'),
    body: z.unknown().optional().describe('A JSON body of at most 16 KiB serialized (§13:325).'),
    authEnv: envName
        .optional()
        .describe('Names a `secret: true` env entry, sent in `Authorization` (§13:326, R15).'),
    authScheme: z
        .enum(APP_SPEC_HTTP_AUTH_SCHEMES)
        .optional()
        .describe(
            'bearer → `Authorization: Bearer <value>`; raw → `Authorization: <value>` (§13:327); default: `bearer`.',
        ),
    expect: z
        .strictObject({
            status: expectedStatuses
                .optional()
                .describe('Expected status codes (§13:328); default: [200, 201, 204].'),
        })
        .optional()
        .describe('What the request must answer with (§13:328).'),
});

/**
 * §13:313-330 — one job (APW-06 runs it as a Kubernetes Job).
 *
 * `command` XOR `http` is required; `component` defaults to
 * `domains.primaryComponent` and must name a component (`component_ref_unknown`,
 * R14); an `http` job needs a `web` component
 * (`http_job_requires_web_component`). `first-deploy` jobs run before the app is
 * exposed publicly (§13:320).
 */
export const appSpecJobSchema = z.strictObject({
    name: name.describe('The job name, unique among jobs (§13:319, R4). Required.'),
    when: z
        .enum(APP_SPEC_JOB_WHENS)
        .describe('pre-deploy · first-deploy · post-deploy (§13:320). Required.'),
    component: name
        .optional()
        .describe('Must name a component (§13:321, R14); default: `domains.primaryComponent`.'),
    command: commandVector.optional().describe('Exactly one of `command` / `http` (§13:322).'),
    http: appSpecHttpRequestSchema
        .optional()
        .describe('The HTTP request the job makes (§13:323-328).'),
    timeoutSeconds: z
        .number()
        .int()
        .min(10)
        .max(3600)
        .optional()
        .describe('10–3600 (§13:329); default: 600.'),
    retries: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe('Retries, 0–3 (§13:330); default: 0.'),
});

/**
 * §14:332-343 — one of the app's own recurring calls, rendered as a cluster
 * CronJob (never a platform Schedule).
 *
 * An unparsable `schedule` is `cron_invalid` and a schedule that fires more often
 * than hourly is `schedule_too_frequent` (R21) — both need a cron parser, so both
 * live in the rule layer; the five-field shape is what is checked here.
 */
export const appSpecCronSchema = z.strictObject({
    name: name.describe('The cron name, unique among cron entries (§14:338, R4). Required.'),
    schedule: z
        .string()
        .regex(APP_SPEC_CRON_FIELD_PATTERN)
        .describe(
            'A five-field cron expression, UTC (§14:339). Required; unparsable is `cron_invalid`.',
        ),
    component: name.optional().describe('Defaults to `domains.primaryComponent` (§14:340).'),
    command: commandVector.optional().describe('Exactly one of `command` / `http` (§14:341).'),
    http: appSpecHttpRequestSchema
        .optional()
        .describe('The HTTP request the fire makes (§14:341, as in §13).'),
    timeoutSeconds: z
        .number()
        .int()
        .min(10)
        .max(3600)
        .optional()
        .describe('10–3600 (§14:342); default: 300.'),
    concurrency: z
        .enum(APP_SPEC_CRON_CONCURRENCIES)
        .optional()
        .describe(
            'What Kubernetes does when a fire is still running (§14:343): forbid · allow; default: `forbid`.',
        ),
});

// ---------------------------------------------------------------------------
// §15 `domains`
// ---------------------------------------------------------------------------

/**
 * §15:345-352 — the public surface (APW-06 renders the Ingress).
 *
 * `primaryComponent` must name a `web` component and is required with two or more
 * of them (`primary_component_invalid`, R3); `publicUrlEnv` names existing `env`
 * entries (`reference_unresolved`, R16).
 */
export const appSpecDomainsSchema = z.strictObject({
    primaryComponent: name
        .optional()
        .describe(
            'The web component that serves the public URL (§15:349, R3); default: the only `web` component.',
        ),
    publicUrlEnv: z
        .array(envName)
        .max(10)
        .optional()
        .describe('At most 10 `env` entries that hold the public URL (§15:350, R16); default: [].'),
    onChange: z
        .enum(APP_SPEC_DOMAIN_CHANGES)
        .optional()
        .describe(
            'What a public-domain change requires (§15:351): restart · rebuild; default: `restart`.',
        ),
    needsHairpin: z
        .boolean()
        .optional()
        .describe(
            'The app calls its own public URL from the server side (§15:352); default: false.',
        ),
});

// ---------------------------------------------------------------------------
// §16 `smoke[]`
// ---------------------------------------------------------------------------

/** §16:361-363 — the `http` block of a smoke check: GET · HEAD · POST, body on POST only. */
export const appSpecSmokeHttpRequestSchema = z.strictObject({
    method: z
        .enum(APP_SPEC_SMOKE_HTTP_METHODS)
        .optional()
        .describe('GET · HEAD · POST (§16:361); default: `GET`.'),
    path: httpPath.describe('The path requested (§16:362). Required.'),
    body: z.unknown().optional().describe('A JSON body of at most 16 KiB, `POST` only (§16:363).'),
});

/**
 * §16:365-368 — what a smoke request must answer.
 *
 * A smoke request never follows redirects, so these judge the first response
 * (CONTRACTS §1:236).
 */
export const appSpecSmokeExpectSchema = z.strictObject({
    status: expectedStatuses
        .optional()
        .describe('Expected status codes (§16:365); default: [200].'),
    bodyContains: z
        .array(z.string().max(200))
        .max(5)
        .optional()
        .describe(
            'At most 5 strings the body must contain, ≤ 200 characters each (§16:366); default: [].',
        ),
    bodyNotContains: z
        .array(z.string().max(200))
        .max(5)
        .optional()
        .describe(
            'At most 5 strings the body must not contain, ≤ 200 characters each (§16:367); default: [].',
        ),
    maxLatencyMs: z
        .number()
        .int()
        .min(100)
        .max(60000)
        .optional()
        .describe('The latency budget in milliseconds, 100–60000 (§16:368); default: 10000.'),
});

/** §16:354-369 — one smoke check (APW-06 runs them after every Deployment; APW-04 gates on them). */
export const appSpecSmokeSchema = z.strictObject({
    name: name.describe('The smoke check name, unique among smoke checks (§16:355, R4). Required.'),
    http: appSpecSmokeHttpRequestSchema.describe('The request to make (§16:361-363). Required.'),
    component: name
        .optional()
        .describe('Must be a `web` component (§16:364, R14); default: `domains.primaryComponent`.'),
    expect: appSpecSmokeExpectSchema
        .optional()
        .describe('What the response must look like (§16:365-368).'),
    when: z
        .enum(APP_SPEC_SMOKE_WHENS)
        .optional()
        .describe('always · first-deploy (§16:369); default: `always`.'),
});

// ---------------------------------------------------------------------------
// §17 `checks[]`
// ---------------------------------------------------------------------------

/**
 * §17:371-380 — a quality gate for Tasks on this App Work, run sandboxed
 * (README §7 rule 9).
 *
 * `required: false` is the warning `advisory_check` — an advisory check verifies
 * nothing. The command's non-whitespace and control-character rules are written
 * as patterns rather than a transform so that the published JSON Schema (T8)
 * enforces exactly what the runtime does.
 */
export const appSpecCheckSchema = z.strictObject({
    name: name.describe('The check name, unique among checks (§17:377, R4). Required.'),
    command: z
        .string()
        .min(1)
        .max(500)
        .regex(/\S/, 'must contain a non-whitespace character')
        .regex(/^[^\u0000-\u001f\u007f]*$/, 'must not contain control characters')
        .describe(
            'The command to run, 1–500 characters with no control characters (§17:378). Required.',
        ),
    required: z
        .boolean()
        .optional()
        .describe(
            'Whether the check gates a Task (§17:379); default: true; false warns `advisory_check`.',
        ),
    timeoutSeconds: z
        .number()
        .int()
        .min(60)
        .max(7200)
        .optional()
        .describe('60–7200 (§17:380); default: 1800.'),
});

// ---------------------------------------------------------------------------
// §18 `agents`
// ---------------------------------------------------------------------------

/**
 * §18:382-389 — the agent instructions a Task on this App Work follows (APW-08
 * owns the semantics).
 *
 * `requireHumanMergePaths` is the CONTRACTS §1 "Additions (APW-08)" key added on
 * 2026-09-17: paths whose changes **only a person may merge**, whatever the merge
 * policy says. It is at most
 * {@link APP_SPEC_MAX_REQUIRE_HUMAN_MERGE_PATHS} globs, defaults to `[]`, and a
 * **removal** from it is reported by `diffGuardedSpecBlocks` (CONTRACTS §2A:325).
 */
export const appSpecAgentsSchema = z.strictObject({
    instructionFiles: z
        .array(relPath)
        .max(10)
        .optional()
        .describe('At most 10 instruction files (§18:386); default: [].'),
    maxPullRequestChangedLines: z
        .number()
        .int()
        .min(50)
        .max(5000)
        .optional()
        .describe('The largest pull request, in changed lines, 50–5000 (§18:387); default: 500.'),
    maxPullRequestChangedFiles: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('The largest pull request, in changed files, 1–500 (§18:388); default: 50.'),
    requireHumanMergePaths: z
        .array(glob)
        .max(APP_SPEC_MAX_REQUIRE_HUMAN_MERGE_PATHS)
        .optional()
        .describe(
            `Paths only a person may merge (§18:389, CONTRACTS §1): at most ` +
                `${APP_SPEC_MAX_REQUIRE_HUMAN_MERGE_PATHS} globs; default: [].`,
        ),
});

// ---------------------------------------------------------------------------
// §19 `upstreamSync`
// ---------------------------------------------------------------------------

/**
 * §19:391-400 — how the fork follows its upstream (APW-02 owns the sync).
 *
 * **Forbidden when `source.relation` is `link`**
 * (`upstream_sync_requires_upstream`, R13) — a linked repository has no upstream
 * — and a schedule that fires more often than once per 60 minutes is
 * `schedule_too_frequent` (R21).
 */
export const appSpecUpstreamSyncSchema = z.strictObject({
    enabled: z
        .boolean()
        .optional()
        .describe('Whether upstream sync runs (§19:397); default: true.'),
    schedule: z
        .string()
        .regex(APP_SPEC_CRON_FIELD_PATTERN)
        .optional()
        .describe(
            'A five-field cron expression (§19:398); default: `0 6 * * 1`; ≥ 60 minutes apart (R21).',
        ),
    mode: z
        .enum(APP_SPEC_UPSTREAM_SYNC_MODES)
        .optional()
        .describe('How the sync lands (§19:399): `merge` only.'),
    branch: gitRef
        .optional()
        .describe('The branch synced (§19:400); default: `upstream.defaultBranch`.'),
});

// ---------------------------------------------------------------------------
// §20 `upstreamPullRequests` and `provisioning`
// ---------------------------------------------------------------------------

/**
 * §20:402-408 — the pull requests the platform opens upstream (APW-09 owns them).
 *
 * `enabled: true` requires `source.relation: fork` (`upstream_prs_require_fork`,
 * R13), and `requireApproval` can only be `true` — a person always approves
 * (R12, `upstream_pr_approval_required`).
 */
export const appSpecUpstreamPullRequestsSchema = z.strictObject({
    enabled: z
        .boolean()
        .optional()
        .describe('Whether upstream pull requests are opened (§20:406); default: false.'),
    requireApproval: z
        .boolean()
        .optional()
        .describe('Only `true` is valid (§20:407, R12); default: true.'),
    maxOpen: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe('At most this many open, 1–10 (§20:408); default: 3.'),
});

/**
 * §20:410-414 — the CONTRACTS §1 "Additions (APW-04)" key.
 *
 * The owner's opt-in to automatic re-provisioning when an Upstream sync breaks
 * the smoke tests. The App Provisioner never writes this block and treats it as a
 * preserved field.
 */
export const appSpecProvisioningSchema = z.strictObject({
    autoReprovision: z
        .boolean()
        .optional()
        .describe(
            'Re-provision automatically when an Upstream sync breaks the smoke tests (§20:414); default: false.',
        ),
});

// ---------------------------------------------------------------------------
// The document — schema.md §1 and §4–§20
// ---------------------------------------------------------------------------

/**
 * The App spec: the `spec` block of a `.works/works.yml` when `kind: app`
 * (schema.md §4:95-117; FR-1), and the whole document of a stand-alone
 * `app-spec.yml`.
 *
 * `kind` and `appSpecVersion` are the two envelope keys the spec accepts
 * (§1:63-65): `spec.kind` must equal the root kind when both are present
 * (`kind_mismatch`), and a newer `appSpecVersion` that is still within
 * {@link APP_SPEC_VERSION_MAX} downgrades `unknown_field` to the warning
 * `unknown_field_newer_version` (§2:76-77). Every other key is a block of §5–§20;
 * a key this schema does not define is `unknown_field`, and an `x-` key is
 * removed by {@link stripExtensionKeys} before parsing so that it stays silent
 * (§2:74-75).
 *
 * **`source` is optional because the requirement is mode-scoped**: §4:99 marks it
 * required for `data-repository` mode only, and §3:89 allows — and expects — it
 * in `blueprint` mode, where a Blueprint's own file is validated with the same
 * rules. The `data-repository` requirement is reported as an issue by the
 * validator, not enforced by the type or by this schema.
 */
export const appSpecSchema = z.strictObject({
    kind: z
        .literal('app')
        .optional()
        .describe('Repeats the root `kind`; must equal it when both are present (§1:64).'),
    appSpecVersion: z
        .number()
        .int()
        .min(APP_SPEC_VERSION_MIN)
        .max(APP_SPEC_VERSION_MAX)
        .optional()
        .describe(
            `The App spec version, ${APP_SPEC_VERSION_MIN}–${APP_SPEC_VERSION_MAX} (§1:65); default: 1.`,
        ),
    source: appSpecSourceSchema
        .optional()
        .describe('Where the repository came from (§5); required in `data-repository` mode.'),
    blueprint: appSpecBlueprintSchema.optional().describe('The Blueprint that was applied (§6).'),
    license: appSpecLicenseSchema.optional().describe('Informational licence declaration (§7).'),
    display: appSpecDisplaySchema.optional().describe('How the Work presents itself (§8).'),
    build: appSpecBuildSchema
        .optional()
        .describe('How the image is produced (§9); required when `components` is non-empty.'),
    components: z
        .array(appSpecComponentSchema)
        .max(10)
        .optional()
        .describe('At most 10 components (§10); at least one when `build.strategy` ≠ `none` (R2).'),
    dependencies: appSpecDependenciesSchema
        .optional()
        .describe('The managed services the app needs (§11).'),
    env: z
        .array(appSpecEnvEntrySchema)
        .max(200)
        .optional()
        .describe('At most 200 env entries (§12), names unique (R4).'),
    jobs: z
        .array(appSpecJobSchema)
        .max(10)
        .optional()
        .describe('At most 10 jobs (§13), names unique (R4).'),
    cron: z
        .array(appSpecCronSchema)
        .max(20)
        .optional()
        .describe('At most 20 cron entries (§14), names unique (R4).'),
    domains: appSpecDomainsSchema.optional().describe('The public surface (§15).'),
    smoke: z
        .array(appSpecSmokeSchema)
        .max(20)
        .optional()
        .describe('At most 20 smoke checks (§16), names unique (R4).'),
    checks: z
        .array(appSpecCheckSchema)
        .max(20)
        .optional()
        .describe('At most 20 checks (§17), names unique (R4).'),
    agents: appSpecAgentsSchema
        .optional()
        .describe('Agent instructions for Tasks on this App Work (§18).'),
    upstreamSync: appSpecUpstreamSyncSchema
        .optional()
        .describe('How the fork follows its upstream (§19).'),
    upstreamPullRequests: appSpecUpstreamPullRequestsSchema
        .optional()
        .describe('The pull requests the platform opens upstream (§20).'),
    provisioning: appSpecProvisioningSchema
        .optional()
        .describe('Automatic re-provisioning (CONTRACTS §1, APW-04; §20).'),
});

/** The parsed App spec — `z.infer` of {@link appSpecSchema}, which the T1 contract `AppSpec` mirrors. */
export type ParsedAppSpec = z.infer<typeof appSpecSchema>;

/**
 * Remove every `x-` key from a **copy** of `value`, at any depth.
 *
 * schema.md §2:74-75: "Any key starting with `x-` is allowed at any depth inside
 * `spec`, preserved, and ignored." Preservation is the writer's job — the raw
 * document is what round-trips — so the validator works on a copy with the
 * extension keys removed (plan §2.2:137-138, right before
 * `appSpecSchema.safeParse`), which is what keeps them silent instead of
 * producing `unknown_field` for a key the format explicitly allows.
 *
 * The input is never mutated: every plain mapping and every array is rebuilt.
 * A key is copied with `Object.defineProperty` rather than assignment so that a
 * hand-written `__proto__` key stays an ordinary key instead of reaching the
 * prototype — this function runs on attacker-controlled YAML.
 *
 * Non-plain objects (a `Date`, a `Map`, a class instance) are returned as they
 * are: they are not mappings this format defines, and rebuilding them by
 * enumeration would silently empty them.
 */
export function stripExtensionKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => stripExtensionKeys(entry));
    }

    if (typeof value !== 'object' || value === null) {
        return value;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return value;
    }

    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key.startsWith(APP_SPEC_EXTENSION_KEY_PREFIX)) {
            continue;
        }
        Object.defineProperty(copy, key, {
            value: stripExtensionKeys(entry),
            enumerable: true,
            writable: true,
            configurable: true,
        });
    }

    return copy;
}
