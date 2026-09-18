/**
 * The App spec **issue builder** — every code of `schema.md` §23 turned into the
 * English `message` + `hint` a caller publishes, plus the Damerau–Levenshtein
 * suggestion `unknown_field` carries.
 *
 * Owning epic: **APW-03** (task T6). Plan: `plan.md` §2.2:153-155 —
 * "`app-spec.issues.ts` _(new)_ holds `APP_SPEC_ISSUE_CODES` and a
 * `describeIssue(code, params)` builder producing English `message` + `hint`.
 * Params never include values of secret entries, build args or prompt examples
 * (FR-6) — the builder takes names only, enforced by its parameter type."
 *
 * ## Where the code list actually lives, and why this module only carries it
 *
 * `APP_SPEC_ISSUE_CODES` already exists on the contract side
 * (`packages/contracts/src/apps/app-spec-issues.ts`, T1) and is **re-exported**
 * here rather than declared a second time: the list is append-only
 * (§23:536, Constitution X) and two copies of an append-only list is exactly how
 * one of them goes stale. What this module *does* add is the split the validator
 * needs — {@link APP_SPEC_STRUCTURAL_ISSUE_CODES}, whose §23 order is pinned
 * against the contract tuple by a test, and
 * {@link APP_SPEC_SERVER_ONLY_ISSUE_CODES}, the five of §22:483-488.
 *
 * ## How "names only" is enforced (FR-6, §23:534)
 *
 * A nominal `params` type that literally admitted only names is not expressible:
 * T5's `AppSpecRuleFinding.params` is `Record<string, string | number | boolean>`
 * and `describeIssue(finding.code, finding.params)` has to type-check, so
 * narrowing the parameter type here would push a cast onto every call site and
 * enforce nothing at runtime.
 *
 * The guarantee is therefore made where it can actually hold — in the builder:
 *
 * 1. {@link APP_SPEC_ISSUE_PARAM_NAMES} is the **closed** set of parameter names
 *    `describeIssue` reads. Everything else is ignored, however it is spelled.
 * 2. Each of those names is a *name or a scalar fact about the document* (a key,
 *    an entry name, a component name, a count, a limit) — never a leaf's value.
 * 3. The value-carrying names the spec calls out — `value`, `example`, `body`,
 *    `template` text, `args` — are **absent** from the set, so a message cannot
 *    echo one even if a caller hands one over.
 * 4. `app-spec.issues.spec.ts` proves it: a property test inserts random
 *    secret-shaped strings into `build.args[].value`, `env[].value` of a
 *    `secret: true` entry and `prompt.example`, then asserts no issue produced
 *    for that document contains any of them — in `message`, `hint`, `path`,
 *    `pointer`, `displayPath` or `params` (ACC-03-04, FR-6).
 */

import {
    APP_SPEC_ISSUE_CODES,
    APP_SPEC_SUGGESTION_MAX_DISTANCE,
    type AppSpecIssueCode,
} from '@ever-works/contracts';

export { APP_SPEC_ISSUE_CODES };
export type { AppSpecIssueCode };

// ---------------------------------------------------------------------------
// The code lists the validator splits §23's catalogue into
// ---------------------------------------------------------------------------

/**
 * §23:538-543 — the structural codes, in the order that paragraph prints them.
 *
 * The order is not cosmetic: `apps-contracts.spec.ts` pins the contract tuple as
 * a snapshot and the first {@link APP_SPEC_STRUCTURAL_ISSUE_CODES}`.length`
 * entries of it are exactly this list, which a test in this task's own spec file
 * asserts. Adding a structural code means appending to the contract tuple and
 * appending here, in the same edit.
 */
export const APP_SPEC_STRUCTURAL_ISSUE_CODES: readonly AppSpecIssueCode[] = [
    'yaml_syntax',
    'file_too_large',
    'yaml_alias_limit',
    'duplicate_key',
    'kind_mismatch',
    'required',
    'invalid_type',
    'invalid_enum',
    'out_of_range',
    'pattern',
    'unknown_field',
    'unknown_field_newer_version',
    'blueprint_mode_forbidden_key',
    'pattern_unsupported',
    'prompt_example_secret',
    'generated_not_secret',
    'worker_port_forbidden',
    'worker_probe_without_port',
    'http_job_requires_web_component',
    'public_bucket_undeclared',
    'extension_unavailable',
    'cron_invalid',
    'reference_syntax',
    'template_cycle',
    'template_too_deep',
    'blueprint_repo_outside_org',
];

/**
 * §22:483-488 — the codes that need platform state, so an editor can never run
 * them. Four of the five — `build_strategy_unavailable`, `dependency_unavailable`
 * and the two relation/branch ones — are T6's own; the fifth,
 * `license_declared_mismatch`, is R24 and lives with T5's rules.
 */
export const APP_SPEC_SERVER_ONLY_ISSUE_CODES: readonly AppSpecIssueCode[] = [
    'source_relation_mismatch',
    'blueprint_unknown',
    'build_strategy_unavailable',
    'dependency_unavailable',
    'tracked_branch_missing',
];

// ---------------------------------------------------------------------------
// Params: the closed list of names a message may interpolate
// ---------------------------------------------------------------------------

/**
 * Every parameter name {@link describeIssue} reads.
 *
 * This is the whole of the builder's vocabulary, and it is deliberately
 * **closed**: a name that is not here reaches no message, so a caller cannot
 * leak a leaf value through a parameter the builder does not know. The list is
 * made of names (`component`, `entry`, `job`, …), places (`path`, `field`) and
 * scalar facts (`count`, `depth`, `limit`, `bytes`) — never a value read out of
 * the document for a secret entry, a build argument or a prompt example.
 */
export const APP_SPEC_ISSUE_PARAM_NAMES = [
    // names of things in the document (§23:532 uses the same names for displayPath)
    'key',
    'suggestion',
    'name',
    'entry',
    'component',
    'job',
    'cron',
    'smoke',
    'check',
    'argument',
    'volume',
    'probe',
    'block',
    'declaredBy',
    'reference',
    'needs',
    'sources',
    'entries',
    'strategy',
    'relation',
    'recorded',
    'declared',
    'root',
    'path',
    'prefix',
    'kind',
    'target',
    'bucket',
    'extension',
    'format',
    'type',
    'supportedBy',
    'id',
    'branch',
    'spdx',
    'registry',
    'schedule',
    'reason',
    'pattern',
    // scalar facts about the document, never a leaf's value
    'count',
    'depth',
    'limit',
    'max',
    'min',
    'length',
    'generated',
    'minLength',
    'maxLength',
    'samples',
    'minutes',
    'bytes',
    'maxBytes',
    'replicas',
    'volumes',
    'components',
    'webComponents',
    'detected',
    'appSpecVersion',
    'supported',
    'expected',
    'allowed',
    'skippedRules',
] as const;

/** One name of {@link APP_SPEC_ISSUE_PARAM_NAMES}. */
export type AppSpecIssueParamName = (typeof APP_SPEC_ISSUE_PARAM_NAMES)[number];

/**
 * The parameters a caller may hand {@link describeIssue}.
 *
 * The type is the loose record T5's findings carry — so
 * `describeIssue(finding.code, finding.params)` type-checks without a cast — but
 * the **contract** is names only, and {@link APP_SPEC_ISSUE_PARAM_NAMES} is the
 * mechanism that makes it true rather than aspirational. See this module's
 * header.
 */
export type AppSpecIssueParams = Readonly<Record<string, string | number | boolean>>;

/** One issue's English text (§23:526-527). `hint` is optional. */
export interface AppSpecIssueText {
    readonly message: string;
    readonly hint?: string;
}

// ---------------------------------------------------------------------------
// Suggestions (§2:70, plan §2.2:150)
// ---------------------------------------------------------------------------

/**
 * Damerau–Levenshtein distance — Levenshtein plus the transposition of two
 * adjacent characters, which is what makes `replica` → `replicas` distance 1 and
 * `replcia` → `replicas` distance 2 rather than 3.
 *
 * Iterative and bounded by the two lengths; the caller only ever passes short
 * key names and it never sees attacker-sized input (a YAML key inside a 256 KiB
 * file), so no early-exit heuristic is needed to keep it cheap.
 */
export function damerauLevenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const rows: number[][] = [];
    for (let i = 0; i <= a.length; i += 1) rows.push(new Array<number>(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i += 1) rows[i][0] = i;
    for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;

    for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            rows[i][j] = Math.min(
                rows[i - 1][j] + 1,
                rows[i][j - 1] + 1,
                rows[i - 1][j - 1] + cost,
            );
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + cost);
            }
        }
    }

    return rows[a.length][b.length];
}

/**
 * The defined key `key` was meant to be, or `null`.
 *
 * §2:70 — "with a suggestion when a defined key is within edit distance 2
 * (`replica` → `replicas`)". §2.2:150 adds the tie-break: "ties resolve
 * alphabetically". `key` itself is never suggested.
 */
export function suggestKey(
    key: string,
    allowed: readonly string[],
    maxDistance: number = APP_SPEC_SUGGESTION_MAX_DISTANCE,
): string | null {
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const candidate of allowed) {
        if (candidate === key) continue;
        const distance = damerauLevenshtein(key, candidate);
        if (distance > maxDistance) continue;
        if (
            distance < bestDistance ||
            (distance === bestDistance && best !== null && candidate < best)
        ) {
            best = candidate;
            bestDistance = distance;
        }
    }

    return best;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/** A parameter, or `undefined` when it is absent or not a scalar. */
function text(params: AppSpecIssueParams | undefined, name: AppSpecIssueParamName): string | null {
    if (params === undefined || params === null) return null;
    const value = params[name];
    if (value === undefined || value === null) return null;
    return String(value);
}

/** A parameter rendered in backticks, or `null` when it is absent. */
function quoted(
    params: AppSpecIssueParams | undefined,
    name: AppSpecIssueParamName,
): string | null {
    const value = text(params, name);
    return value === null ? null : `\`${value}\``;
}

/** A parameter rendered as a number, or `null` when it is absent or not numeric. */
function numeric(
    params: AppSpecIssueParams | undefined,
    name: AppSpecIssueParamName,
): number | null {
    const value = params?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return null;
}

/** The first present, backticked parameter of `names` — for codes with aliases. */
function firstQuoted(
    params: AppSpecIssueParams | undefined,
    names: readonly AppSpecIssueParamName[],
): string | null {
    for (const name of names) {
        const value = quoted(params, name);
        if (value !== null) return value;
    }
    return null;
}

/** `\`X\``, or a neutral word when the parameter is absent. */
function named(
    params: AppSpecIssueParams | undefined,
    name: AppSpecIssueParamName,
    fallback: string,
): string {
    return quoted(params, name) ?? fallback;
}

/**
 * The English `message` and `hint` for one code.
 *
 * Every code of `APP_SPEC_ISSUE_CODES` has an entry, so the builder is total —
 * including the codes T4 and T5 emit and the ones that are never emitted today
 * (`blueprint_mode_forbidden_key`, kept per §3:89). A code this build does not
 * know falls back to a neutral sentence built from the code itself rather than
 * throwing: `describeIssue` is on the validator's never-throws path.
 */
const DESCRIBERS: Readonly<Record<string, (p?: AppSpecIssueParams) => AppSpecIssueText>> = {
    // ── structural (§23:538-543) ───────────────────────────────────────────
    yaml_syntax: () => ({
        message: 'The file is not valid YAML.',
        hint: 'Fix the syntax at the reported line; nothing else can be checked until the file parses.',
    }),
    file_too_large: (p) => ({
        message: `The file is ${numeric(p, 'bytes') ?? '?'} bytes; the limit is ${
            numeric(p, 'maxBytes') ?? '?'
        } bytes.`,
        hint: 'Keep `.works/works.yml` at or below 256 KiB — move long values out of the spec.',
    }),
    yaml_alias_limit: (p) => ({
        message: `The document expands more than ${numeric(p, 'max') ?? '?'} YAML aliases.`,
        hint: 'Inline the anchored values, or split the file; aliases are counted after expansion.',
    }),
    duplicate_key: (p) => ({
        message: `${named(p, 'key', 'A key')} is declared more than once in the same mapping.`,
        hint: 'Delete the duplicate — only the last value is read today, so the earlier one is silently lost.',
    }),
    kind_mismatch: (p) => ({
        message: `The root kind is ${named(p, 'root', 'unset')} but \`spec.kind\` is ${named(
            p,
            'declared',
            'unset',
        )}.`,
        hint: 'Make the two spellings of `kind` agree, or delete `spec.kind` — it repeats the root.',
    }),
    required: (p) => ({
        message: `${named(p, 'key', 'A required key')} is required.`,
        hint: 'Add the key to the `spec` block.',
    }),
    invalid_type: (p) => ({
        message: `${named(p, 'key', 'A value')} has the wrong type${
            text(p, 'expected') === null ? '' : ` (expected ${text(p, 'expected')})`
        }.`,
        hint: 'Correct the type — the App spec fixes one type per field.',
    }),
    invalid_enum: (p) => ({
        message: `${named(p, 'key', 'A value')} is not one of the allowed values${
            text(p, 'allowed') === null ? '' : ` (${text(p, 'allowed')})`
        }.`,
        hint: 'Use one of the listed values.',
    }),
    out_of_range: (p) => {
        const limit = numeric(p, 'limit');
        const depth = numeric(p, 'depth');
        if (limit !== null && depth !== null) {
            return {
                message: `The document nests ${depth} levels deep; the limit is ${limit}.`,
                hint: 'Flatten the document, or move deeply nested values into an anchor-free block.',
            };
        }
        return {
            message: `${named(p, 'key', 'A value')} is outside the allowed range.`,
            hint: 'Check the bound in the App spec reference for this field.',
        };
    },
    pattern: (p) => ({
        message: `${named(p, 'key', 'A value')} does not match the required format.`,
        hint: 'Correct the value; the field’s format is fixed by the App spec.',
    }),
    unknown_field: (p) => {
        const suggestion = quoted(p, 'suggestion');
        return {
            message: `Unknown field ${named(p, 'key', '?')}.${
                suggestion === null ? '' : ` Did you mean ${suggestion}?`
            }`,
            hint: 'Delete the key, or rename it to the suggested one. `x-` prefixed keys are the only extensions allowed.',
        };
    },
    unknown_field_newer_version: (p) => {
        const suggestion = quoted(p, 'suggestion');
        const message = `Unknown field ${named(p, 'key', '?')}.${
            suggestion === null ? '' : ` Did you mean ${suggestion}?`
        }`;
        return {
            message,
            hint: `Reported as a warning: the spec declares \`appSpecVersion: ${
                numeric(p, 'appSpecVersion') ?? '?'
            }\` and this build understands ${numeric(p, 'supported') ?? '?'}, so the key may be defined there.`,
        };
    },
    blueprint_mode_forbidden_key: (p) => ({
        message: `${named(p, 'key', 'A key')} is not allowed in blueprint mode.`,
        hint: 'Remove the key from the Blueprint’s own `.works/works.yml`.',
    }),
    pattern_unsupported: (p) => ({
        message: `${named(p, 'entry', 'The entry')} uses a \`validate.pattern\` the resolver cannot run.`,
        hint: 'RE2 has no look-around and no back-references — rewrite the pattern without them.',
    }),
    prompt_example_secret: (p) => ({
        message: `${named(p, 'entry', 'The entry')} has a prompt example that looks like a real credential.`,
        hint: 'Replace the example with a placeholder — it is shown to whoever fills the value in.',
    }),
    generated_not_secret: (p) => ({
        message: `${named(p, 'entry', 'The entry')} is generated, so it must be \`secret: true\`.`,
        hint: 'Add `secret: true`, or drop the `generate` block and provide a value instead.',
    }),
    worker_port_forbidden: (p) => ({
        message: `${named(p, 'component', 'The component')} is a worker, so it must not declare \`port\`.`,
        hint: 'Delete `port` — only a `web` component is exposed.',
    }),
    worker_probe_without_port: (p) => ({
        message: `${named(p, 'component', 'The component')} has a TCP probe but declares no \`port\`.`,
        hint: 'Declare the port the worker listens on, or use an `http` probe on a port it opens.',
    }),
    http_job_requires_web_component: (p) => ({
        message: `${named(p, 'job', 'The entry')} sends an HTTP request, so it must run on a web component.`,
        hint: 'Point `component` at a `web` component, or use a `command` instead of `http`.',
    }),
    public_bucket_undeclared: (p) => ({
        message: `${named(p, 'bucket', 'The bucket')} is not declared in \`dependencies.objectStorage.buckets\`.`,
        hint: 'Add the bucket to `buckets`, or remove it from `publicBuckets`.',
    }),
    extension_unavailable: (p) => ({
        message: `The Postgres extension ${named(p, 'extension', 'requested')} is not available.`,
        hint: 'Remove it, or choose a provider that ships it.',
    }),
    cron_invalid: (p) => ({
        message: `${named(p, 'schedule', 'The schedule')} is not a valid five-field cron expression.`,
        hint: 'Use `minute hour day-of-month month day-of-week`, in UTC — for example `30 3 * * *`.',
    }),
    reference_syntax: (p) => ({
        message: `${named(p, 'reference', 'The placeholder')} is not a reference this format defines.`,
        hint: 'See the reference syntax table: `domains.primary.*`, `deps.<kind>.<output>`, `platform.smtp.*`, `build.commitSha`, `components.<name>.internalUrl`, `env.<NAME>`.',
    }),
    template_cycle: (p) => ({
        message: `Template cycle between ${named(p, 'entries', 'entries')}.`,
        hint: 'Break the cycle — a template cannot read a value that reads it back.',
    }),
    template_too_deep: (p) => ({
        message: `${named(p, 'entry', 'The entry')} resolves ${numeric(p, 'depth') ?? '?'} levels deep; the limit is ${
            numeric(p, 'max') ?? '?'
        }.`,
        hint: 'Inline part of the chain — resolution follows `template` edges only.',
    }),
    blueprint_repo_outside_org: () => ({
        message: '`blueprint.repo` is outside the `ever-works/` organization.',
        hint: 'A Blueprint’s repository is always `ever-works/<name>`.',
    }),

    // ── rules R1–R27 (§22:455-481) ─────────────────────────────────────────
    web_component_needs_port: (p) => ({
        message: 'Web components must declare the port they listen on.',
        hint: `Add \`port: <number>\` under the ${named(p, 'component', 'web')} component.`,
    }),
    strategy_requires_components: (p) => ({
        message: `\`build.strategy: ${text(p, 'strategy') ?? '?'}\` builds an image, so the spec needs a component.`,
        hint: 'Add at least one entry to `components`, or set `build.strategy: none`.',
    }),
    components_require_strategy: () => ({
        message: 'A spec with components must declare `build.strategy`.',
        hint: 'Add `strategy: dockerfile`, `image` or `auto` under `build`.',
    }),
    primary_component_invalid: (p) => ({
        message:
            text(p, 'component') === null
                ? '`domains.primaryComponent` is required when there is more than one `web` component.'
                : `\`domains.primaryComponent\` names ${named(p, 'component', '?')}, which is not a web component.`,
        hint: `Name one of the web components${
            text(p, 'webComponents') === null ? '' : `: ${text(p, 'webComponents')}`
        }.`,
    }),
    duplicate_name: (p) => ({
        message: `The name ${named(p, 'name', '?')} is used more than once in \`${text(p, 'block') ?? 'spec'}\`.`,
        hint:
            p?.generated === true
                ? `It collides with the implicit \`<NAME>_PUBLIC\` of \`${text(p, 'declaredBy') ?? '?'}\`.`
                : 'Rename one of the entries — names are the handles other fields use.',
    }),
    reference_unresolved: (p) => {
        const reference = quoted(p, 'reference');
        const needs = quoted(p, 'needs');
        if (reference !== null && needs !== null) {
            return {
                message: `${reference} needs ${needs}.`,
                hint: `Declare ${needs}, or change the reference.`,
            };
        }
        if (reference !== null) {
            return {
                message: `${reference} cannot be resolved here.`,
                hint: 'Check the reference syntax table for what has to exist for it to resolve.',
            };
        }
        return {
            message: `${named(p, 'entry', 'A reference')} is not declared.`,
            hint: 'Declare the entry the reference names.',
        };
    },
    secret_reference_not_secret: (p) => ({
        message: `${named(p, 'entry', 'The entry')} reads a secret output, so it must be \`secret: true\`.`,
        hint: `It reads ${quoted(p, 'reference') ?? 'a secret value'}; add \`secret: true\`.`,
    }),
    phase_mismatch: (p) => ({
        message: `${named(p, 'entry', 'The entry')} reads ${named(
            p,
            'reference',
            'a value',
        )}, which exists in a different phase.`,
        hint: 'A `runtime` entry cannot read a `build`-only value, and the reverse.',
    }),
    env_source_count: (p) => ({
        message: `${named(p, 'entry', 'The entry')} has ${
            numeric(p, 'count') ?? text(p, 'count') ?? '?'
        } value sources; exactly one is required.`,
        hint: 'Keep exactly one of `value`, `from`, `template`, `generate` or `prompt`.',
    }),
    literal_secret_value: (p) => ({
        message: `${named(p, 'entry', 'The entry')} is \`secret: true\` and still carries a literal \`value\`.`,
        hint: 'Delete the value and use `from`, `template` or `generate` instead — literals in the file are not secret.',
    }),
    generate_validate_conflict: (p) => ({
        message: `${named(p, 'entry', 'The entry')} declares a \`validate\` rule its generator cannot satisfy.`,
        hint: 'Make `validate` agree with the generated length, or drop the check.',
    }),
    literal_secret_in_build_args: () => ({
        message:
            'Build arguments are stored in image layers. Reference an env entry with `fromEnv`.',
        hint: 'Move the value into a `secret: true` env entry and use `fromEnv: <ENV_NAME>`.',
    }),
    secret_build_arg: (p) => ({
        message: `The build argument ${named(p, 'argument', '?')} reads the secret ${named(
            p,
            'entry',
            'entry',
        )} into an image layer.`,
        hint: 'Pass it at runtime instead — a build argument is readable in the image history.',
    }),
    upstream_pr_approval_required: () => ({
        message: "Upstream pull requests always need a person's approval.",
        hint: 'Remove `requireApproval: false`; the platform never merges upstream without a person.',
    }),
    upstream_forbidden_for_link: () => ({
        message: 'A linked repository has no upstream.',
        hint: 'Delete `source.upstream`, or record the relation as `fork` or `private-copy`.',
    }),
    upstream_sync_requires_upstream: () => ({
        message: '`upstreamSync` needs an upstream to follow.',
        hint: 'Delete the block, or declare `source.upstream`.',
    }),
    upstream_prs_require_fork: (p) => ({
        message: `\`upstreamPullRequests.enabled\` needs \`source.relation: fork\`, not \`${
            text(p, 'relation') ?? '?'
        }\`.`,
        hint: 'Set `enabled: false`, or change the relation.',
    }),
    component_ref_unknown: (p) => ({
        message:
            text(p, 'reason') === 'smoke targets a web component'
                ? `${named(p, 'smoke', 'The smoke check')} must target a web component.`
                : `${named(p, 'job', 'The entry')} names ${named(
                      p,
                      'component',
                      'a component',
                  )}, which does not exist.`,
        hint: 'Name a declared component, or delete `component` to use the primary one.',
    }),
    auth_env_not_secret: (p) => ({
        message: `\`http.authEnv\` names ${named(p, 'entry', '?')}, which ${
            text(p, 'reason') === 'no such entry' ? 'is not declared' : 'is not `secret: true`'
        }.`,
        hint: 'Add the entry with `secret: true` — an auth value is never a literal.',
    }),
    limit_below_request: (p) => ({
        message: `${named(p, 'component', 'The component')} sets a limit below its request.`,
        hint: 'Raise the limit to at least the request, or lower the request.',
    }),
    volume_replicas: (p) => ({
        message: `${named(p, 'component', 'The component')} declares volumes and ${
            numeric(p, 'replicas') ?? '?'
        } replicas — a volume cannot attach to two pods.`,
        hint: 'Set `replicas: 1`, or remove the volumes.',
    }),
    image_not_pinned: () => ({
        message: 'The image is pinned by tag only; a tag can be moved.',
        hint: 'Pin the digest — `image: <name>@sha256:<64 hex>`.',
    }),
    advisory_check: (p) => ({
        message: `${named(p, 'check', 'The check')} is \`required: false\`, so it verifies nothing.`,
        hint: 'Set `required: true` if the check should gate a change.',
    }),
    schedule_too_frequent: (p) => ({
        message: `\`upstreamSync.schedule\` fires every ${numeric(p, 'minutes') ?? '?'} minutes.`,
        hint: 'Consecutive fires must be at least 60 minutes apart.',
    }),
    path_outside_repository: (p) => ({
        message: `${named(p, 'path', 'The path')} is not a repository-relative path.`,
        hint: 'Use a relative path with no leading `/`, no `\\`, no `..` segment and nothing under `.git/`.',
    }),
    reserved_env_name: (p) => ({
        message: `${named(p, 'entry', 'The entry')} uses the reserved \`${
            text(p, 'prefix') ?? 'EVER_WORKS_'
        }\` prefix.`,
        hint: 'Rename the entry — the platform injects that prefix itself.',
    }),
    license_declared_mismatch: (p) => ({
        message: `\`license.class\` is \`${text(p, 'declared') ?? '?'}\` but ${
            quoted(p, 'spdx') ?? 'the licence'
        } classifies as \`${text(p, 'registry') ?? '?'}\`.`,
        hint: 'The gate classifies from detection; align the declaration or delete it.',
    }),
    keypair_format_unsupported: (p) => ({
        message: `${named(p, 'entry', 'The entry')} asks for a raw key format \`${
            text(p, 'type') ?? '?'
        }\` has no form for.`,
        hint: `\`base64url-raw\` is available only for: ${text(p, 'supportedBy') ?? 'ed25519, ec-p256'}.`,
    }),
    keypair_password_invalid: (p) => ({
        message: `${named(p, 'entry', 'The entry')} has an unusable \`keypair.passwordEnv\` (${
            text(p, 'reason') ?? 'invalid'
        }).`,
        hint: '`passwordEnv` is required with `format: pkcs12` and forbidden otherwise, and must name a `secret: true` entry generated with `base64`, `hex` or `chars`.',
    }),
    sourceOfferMissing: () => ({
        message: 'A private repository needs a source offer URL for this licence.',
        hint: 'Add `license.sourceOfferUrl` pointing at where the source can be obtained.',
    }),

    // ── the server-only rules (§22:483-488) ────────────────────────────────
    source_relation_mismatch: (p) => ({
        message: `The spec declares \`source.relation: ${text(p, 'declared') ?? '?'}\` but this App Work was created as \`${
            text(p, 'recorded') ?? '?'
        }\`.`,
        hint: 'A hand edit cannot change the recorded relation — restore it, or create a new App Work.',
    }),
    blueprint_unknown: (p) => ({
        message: `The Apps catalog does not list the Blueprint ${named(p, 'id', '?')}.`,
        hint: 'Upgrade notices stop for an unlisted Blueprint; check the id, or re-apply from the catalog.',
    }),
    build_strategy_unavailable: (p) => ({
        message: `No enabled build plugin supports the \`${text(p, 'strategy') ?? '?'}\` strategy.`,
        hint: 'Switch to a strategy a plugin lists, or enable a build plugin that supports this one.',
    }),
    dependency_unavailable: (p) => ({
        message: `No ${text(p, 'kind') ?? 'dependency'} provider is available${
            text(p, 'target') === null ? '' : ` on ${text(p, 'target')}`
        }.`,
        hint: 'Remove the dependency, or choose a deploy target that provides it.',
    }),
    tracked_branch_missing: (p) => ({
        message: `The tracked branch ${named(p, 'branch', 'declared by the spec')} does not exist.`,
        hint: 'Push the branch, or point `source.branch` at one that exists.',
    }),
};

/**
 * The English text for one issue.
 *
 * `message` is always present; `hint` is present whenever the describer has one.
 * Unknown codes and unknown parameters are handled by falling back rather than
 * throwing, and nothing here ever reads a value-carrying parameter — see
 * {@link APP_SPEC_ISSUE_PARAM_NAMES}.
 */
export function describeIssue(
    code: AppSpecIssueCode,
    params?: AppSpecIssueParams,
): AppSpecIssueText {
    const describer = DESCRIBERS[code];
    if (describer === undefined) {
        return { message: `The App spec reports \`${String(code)}\`.` };
    }
    return describer(params);
}

/** The codes {@link describeIssue} has a hand-written describer for. */
export const APP_SPEC_DESCRIBED_ISSUE_CODES: readonly AppSpecIssueCode[] =
    APP_SPEC_ISSUE_CODES.filter((code) => DESCRIBERS[code] !== undefined);
