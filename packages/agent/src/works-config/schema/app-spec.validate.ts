/**
 * The App spec **validator** — the §2.2 pipeline of `plan.md`, the §23 issue
 * objects it publishes, and the rules T5 deliberately left to T6.
 *
 * Owning epic: **APW-03** (task T6). Plan: `plan.md` §2.2:131-155. Spec:
 * `schema.md` §2 (`strictness, preservation and limits`), §3 (`where validation
 * runs`), §22:483-513 (`the server-only rules`, `which structural problems
 * suppress the rules`), §23 (the issue object). Acceptance: ACC-03-01, -02, -04,
 * -05, -08, -49, -52, -58.
 *
 * ## The pipeline, in the order §2.2 prints it
 *
 * ```
 * text ─► size check (256 KiB) ─► yaml.parseDocument(text, { uniqueKeys, maxAliasCount })
 *      ─► LineCounter positions map: JSON pointer ─► {line, column}
 *      ─► doc.toJS() ─► depth check (12)
 *      ─► stripExtensionKeys(copy)          // `x-*` removed from a COPY; the document is untouched
 *      ─► appSpecSchema.safeParse(copy)     // unrecognized_keys ─► one unknown_field per key
 *      ─► rules R1–R27 (+ the server-only rules when context present)
 *      ─► map pointers to positions; nearest ancestor when a key is absent
 *      ─► sort (errors first, then line); cap 200; newer appSpecVersion ⇒ warning
 * ```
 *
 * ## The rule set runs whenever the document parses (§22:507-513, FR-83)
 *
 * Only four inputs suppress the rules: `yaml_syntax`, `file_too_large`,
 * `yaml_alias_limit` and the depth limit. Every other structural problem is
 * reported **together with** the rule findings, computed over a best-effort copy
 * of the document with the offending keys and invalid leaves removed
 * ({@link repairForRules}) — so `schema.md` §24.4 reports its `unknown_field`
 * **and** its five rule codes in one response.
 *
 * **One leaf, one report.** The repair records every pointer it removed, and a
 * rule finding on such a pointer — or inside such a container — is dropped; that
 * is the mechanical form of §22:511-513's "a single invalid leaf never produces a
 * duplicate report for the same path". The same rule drops a rule finding that
 * collides with an already-published structural one.
 *
 * Two `cron` paths are **deferred** to the layer that owns them rather than
 * repaired away:
 *
 * | Path | Reported by |
 * | ---- | ----------- |
 * | `/spec/cron/<n>/schedule`, `/spec/upstreamSync/schedule` | T5's `cron_invalid` (the shape `pattern` is not published here) |
 *
 * For those two the offending expression is put **back** into the copy the rules
 * read ({@link restoreDeferred}), because T5 can only judge an expression it can
 * see. `/spec/env/<n>/from` needs no such treatment: T3's schema carries no
 * `pattern` on it, so a malformed reference reaches T4's `reference_syntax`
 * untouched.
 *
 * ## What "never throws" costs (FR-8)
 *
 * These entry points read a file from a user's own repository, so a schema
 * quibble must not be able to take their Work offline. Every stage — YAML
 * parsing, `toJS()`, the depth walk, the repair loop, the rule engine — is
 * inside a `try`, and both entry points return a result in every case. A
 * document that cannot be *parsed* is reported (`yaml_syntax`), never raised.
 *
 * ## The context (§22:490-500, FR-84)
 *
 * {@link RuleContext} is the whole of what the server-only rules read, and every
 * field is optional: a field left `null` (or absent) is **unknown**, so its rule
 * is skipped rather than reported. `validateAppSpecDocument(text, { mode })` with
 * no context therefore produces no server-only issue at all (ACC-03-58) — which
 * is why a valid App spec does not read "valid, with warnings" before APW-05 and
 * APW-07 exist.
 */

import {
    APP_SPEC_FILE_MAX_BYTES,
    APP_SPEC_MAX_DEPTH,
    APP_SPEC_MAX_ISSUES,
    APP_SPEC_YAML_MAX_ALIASES,
    type AppSpec,
    type AppSpecIssue,
    type AppSpecIssueCode,
    type AppSpecSeverity,
    type AppSpecSourceRelation,
    type AppSpecValidationMode,
    type AppSpecValidationStatus,
} from '@ever-works/contracts';
import { z } from 'zod/v4';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import { scanForSecrets } from '../../utils/secret-scan';
import { describeIssue, suggestKey, type AppSpecIssueParams } from './app-spec.issues';
import {
    APP_SPEC_DOCUMENT_CHECKS,
    APP_SPEC_RULES,
    displayPathFor,
    evaluateAppSpecRules,
    nearestPosition,
    pointerToPath,
    type AppSpecRuleContext,
    type AppSpecRuleFinding,
    type AppSpecRulePosition,
    type AppSpecRulePositionLookup,
} from './app-spec.rules';
import { APP_SPEC_ISSUE_ROOT } from './app-spec.refs';
import { appSpecSchema, stripExtensionKeys } from './app-spec.schema';

// ---------------------------------------------------------------------------
// Versions, modes and the context
// ---------------------------------------------------------------------------

/**
 * The `appSpecVersion` this build understands — 1.
 *
 * `app-spec.schema.ts` (T3) exports the **bounds** (`APP_SPEC_VERSION_MIN`,
 * `APP_SPEC_VERSION_MAX`) but not the supported version, and this task must not
 * edit a landed module. §2:76-77's downgrade needs exactly this number, so it is
 * declared here, beside the only code that reads it.
 *
 * **Missing export of T3, reported to the coordinator:** the natural home is
 * `APP_SPEC_VERSION = 1` in `app-spec.schema.ts` — it is
 * `_build-artifacts/apw-03-schema/gaps-and-contradictions.md` Q11's own answer,
 * and T8's emitter will want the same constant. Moving it later is a one-line
 * addition there plus a re-export here; nothing else changes.
 */
export const APP_SPEC_SUPPORTED_VERSION = 1;

/**
 * The modes this validator accepts (plan §2.2:131, §3:84-89).
 *
 * `data-repository` (the default) is the platform's own path; `draft` is the
 * contract's name for text a member is still editing, which §3:88 runs through
 * the same rules; `blueprint` is Apps catalog CI validating a Blueprint
 * repository's own file, where §3:89 allows — and expects — `source` and
 * `blueprint`.
 */
export type AppSpecValidatorMode = AppSpecValidationMode | 'blueprint-draft';

/**
 * The mode spellings accepted beyond `APP_SPEC_VALIDATION_MODES`, and the mode
 * each one means.
 *
 * `blueprint-draft` is named twice in `tasks.md` (`:189`, `:606`) as the mode a
 * Blueprint repository's CI runs, but it is **not a member of the contract's mode
 * union** — `packages/contracts/src/apps/app-spec-issues.ts:115-118` says so in
 * as many words, and `schema.md` §3 has no such row. This validator therefore
 * neither invents a fourth mode (which would put the two documents in
 * disagreement) nor refuses a spelling a task names (which would break the
 * catalog's `validate.yml`): it accepts `blueprint-draft` as an **alias** of
 * `blueprint`. That is purely additive — every mode that worked before still
 * works, and a third spelling does too. See this task's report for the full
 * reconciliation of ACC-03-52.
 */
export const APP_SPEC_VALIDATOR_MODE_ALIASES: Readonly<Record<string, AppSpecValidationMode>> = {
    'blueprint-draft': 'blueprint',
};

/** The modes {@link normaliseMode} answers with, after alias resolution. */
export const APP_SPEC_VALIDATOR_MODES: readonly AppSpecValidationMode[] = [
    'data-repository',
    'draft',
    'blueprint',
];

/**
 * Everything a rule may read that is not the document itself (plan §2.2,
 * §22:490-500, FR-84).
 *
 * This is T5's `AppSpecRuleContext` — one shape, so
 * `evaluateAppSpecRules(spec, ctx)` type-checks with no adapter — plus the two
 * fields the server-only rules need and §22's table has no row for:
 *
 * | Field | Rule it serves | Why §22's table cannot carry it |
 * | ----- | -------------- | ------------------------------- |
 * | `deployTarget` | `dependency_unavailable` | §22:499 says "providers **by kind for the Work's deploy target**" — the target is the key, and it is not a property of the document |
 * | `postgresExtensions` | `extension_unavailable` | §11:221 makes availability provider-specific; §22:483-488 lists the code but names no input |
 *
 * Both are optional, and both follow §22:502: absent or `null` means **unknown**,
 * which skips the rule.
 */
export interface RuleContext extends AppSpecRuleContext {
    /** The Work's deploy target, or `null` when unknown (§22:499). */
    readonly deployTarget?: string | null;
    /** The Postgres extensions the configured provider offers, or `null` (§11:221). */
    readonly postgresExtensions?: readonly string[] | null;
}

/** The result of one validation. */
export interface AppSpecValidationResult {
    /**
     * `valid`, `valid_with_warnings` or `invalid`.
     *
     * `missing` and `unreadable` are states of the *evaluation* — no file on the
     * tracked branch; a provider failure kept apart from a real verdict
     * (plan §9.2:826) — and a validator that was handed a document never produces
     * them.
     */
    readonly status: AppSpecValidationStatus;
    /** At most `APP_SPEC_MAX_ISSUES` issues, errors first and then by line (§2.2:141). */
    readonly issues: readonly AppSpecIssue[];
    /** Errors in the **whole** list, before the 200-issue cap. */
    readonly errorCount: number;
    /** Warnings in the **whole** list, before the 200-issue cap. */
    readonly warningCount: number;
    /** `true` when the cap cut the list (§2.5:79-80). */
    readonly truncated: boolean;
    /**
     * The parsed spec, or `null`.
     *
     * Non-null only when the document has **zero errors** — FR-20's rule, and the
     * same condition that lets an evaluation become the effective spec. The
     * best-effort copy the rules ran on is deliberately not exposed: treating it
     * as "the spec" is exactly the mistake strictness exists to prevent.
     */
    readonly spec: AppSpec | null;
    /** Did the rule set run at all? `false` only for the four fatal inputs (FR-83). */
    readonly rulesRan: boolean;
    /**
     * The rules a structural problem suppressed (FR-83: "the response MUST say
     * which"). Empty when nothing was suppressed.
     */
    readonly suppressedRules: readonly string[];
}

/** What {@link validateAppSpecDocument} and {@link validateAppSpecObject} accept. */
export interface AppSpecValidationOptions {
    /** `data-repository` (default), `draft`, `blueprint`, or the `blueprint-draft` alias. */
    readonly mode?: AppSpecValidatorMode | string | null;
    /** §22:490-500's context. Every field optional; absent means unknown. */
    readonly context?: RuleContext | null;
    /**
     * The root `kind`, when the caller holds only the `spec` block.
     *
     * `validateAppSpecObject` accepts either the whole document or the block on
     * its own (see its doc comment). With the block alone there is no root to
     * compare `spec.kind` against, so `kind_mismatch` needs this input; without it
     * the comparison is skipped, exactly as an unknown context field is.
     */
    readonly rootKind?: string | null;
}

// ---------------------------------------------------------------------------
// Small defensive accessors
// ---------------------------------------------------------------------------

/** Is `value` a plain object (not an array, not `null`)? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The components of a document, defensively.
 *
 * The rules in this module read the repaired copy, which normally parses — but
 * the repair loop's fallback is "give up", and `?? []` does not save a caller
 * from a value of the wrong *kind*. Every access below is therefore guarded, and
 * every rule body is additionally wrapped by {@link safeEvaluate}.
 */
function componentsOf(spec: AppSpec | null): readonly NonNullable<AppSpec['components']>[number][] {
    return spec !== null && Array.isArray(spec.components) ? spec.components : [];
}

/** The `env` entries of a document, defensively. */
function envEntriesOf(spec: AppSpec | null): readonly NonNullable<AppSpec['env']>[number][] {
    return spec !== null && Array.isArray(spec.env) ? spec.env : [];
}

/** The `web` components of a document. */
function webComponentsOf(
    spec: AppSpec | null,
): readonly NonNullable<AppSpec['components']>[number][] {
    return componentsOf(spec).filter((component) => component?.role === 'web');
}

/** `/spec/components/0/port` from a path of zod segments. */
function pointerOf(path: readonly (string | number)[]): string {
    const tail = path.map((segment) => String(segment)).join('/');
    return tail.length === 0 ? APP_SPEC_ISSUE_ROOT : `${APP_SPEC_ISSUE_ROOT}/${tail}`;
}

/** The path a pointer spells, as zod reports paths. */
function pathOf(pointer: string): readonly (string | number)[] {
    return pointer
        .slice(APP_SPEC_ISSUE_ROOT.length)
        .split('/')
        .filter((segment) => segment.length > 0)
        .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
}

/**
 * The component an `http` job or cron entry runs on (§13:321).
 *
 * `component` explicitly, else `domains.primaryComponent`, else the only `web`
 * component — the same resolution R14 uses, and the reason
 * `http_job_requires_web_component` can fire on an entry that names no component
 * at all.
 */
function resolvedComponentName(spec: AppSpec | null, explicit: unknown): string | null {
    if (typeof explicit === 'string' && explicit.length > 0) return explicit;
    const primary = spec?.domains?.primaryComponent;
    if (typeof primary === 'string' && primary.length > 0) return primary;
    const web = webComponentsOf(spec);
    return web.length === 1 ? (web[0]?.name ?? null) : null;
}

// ---------------------------------------------------------------------------
// The structural cross-field codes T6 owns (schema.md §23:538-543)
// ---------------------------------------------------------------------------

/** One structural cross-field rule — a §23 code that reads the parsed document. */
export interface AppSpecStructuralRule {
    /** Stable name, used in {@link AppSpecValidationResult.suppressedRules}. */
    readonly name: string;
    readonly codes: readonly AppSpecIssueCode[];
    readonly evaluate: (spec: AppSpec, ctx: RuleContext) => readonly AppSpecRuleFinding[];
}

/** One server-only rule of §22:483-488. */
export interface AppSpecServerOnlyRule {
    readonly name: string;
    readonly code: AppSpecIssueCode;
    readonly severity: AppSpecSeverity;
    readonly evaluate: (spec: AppSpec, ctx: RuleContext) => readonly AppSpecRuleFinding[];
}

/**
 * `worker_port_forbidden` — §10:199: `port` is "Forbidden for `worker`".
 *
 * A structural code rather than a rule of §22: a worker has no Service and no
 * Ingress, so a declared port is silently ignored — the failure mode strictness
 * exists to prevent.
 */
export function checkWorkerPort(
    spec: AppSpec,
    ctx: RuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    componentsOf(spec).forEach((component, index) => {
        if (component?.role !== 'worker') return;
        if (component.port === undefined || component.port === null) return;
        findings.push(
            finding(
                ctx,
                spec,
                'worker_port_forbidden',
                'error',
                pointerOf(['components', index, 'port']),
                {
                    component: component.name ?? '',
                    port: component.port,
                },
            ),
        );
    });
    return findings;
}

/**
 * `worker_probe_without_port` — §10:212-213: "A `worker` probe must use `tcp`
 * only with a declared port, so workers use no probe or an `http` probe on a port
 * they open (warning `worker_probe_without_port`)."
 */
export function checkWorkerProbeWithoutPort(
    spec: AppSpec,
    ctx: RuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    componentsOf(spec).forEach((component, index) => {
        if (component?.role !== 'worker') return;
        if (component.port !== undefined && component.port !== null) return;
        for (const name of ['startup', 'readiness', 'liveness'] as const) {
            if (component.probes?.[name]?.tcp !== true) continue;
            findings.push(
                finding(
                    ctx,
                    spec,
                    'worker_probe_without_port',
                    'warning',
                    pointerOf(['components', index, 'probes', name, 'tcp']),
                    { component: component.name ?? '', probe: name },
                ),
            );
        }
    });
    return findings;
}

/**
 * `http_job_requires_web_component` — §13:321: "An `http` job needs a `web`
 * component".
 *
 * Reported when the resolved component exists and is not `web`, and also when
 * nothing resolves because the document declares no `web` component at all — an
 * HTTP request has nowhere to go in either case. A `component` that names
 * nothing existing is left to R14's `component_ref_unknown`, so one leaf is never
 * reported twice.
 */
export function checkHttpJobRequiresWebComponent(
    spec: AppSpec,
    ctx: RuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    const byName = new Map(componentsOf(spec).map((component) => [component.name, component]));
    const anyWeb = webComponentsOf(spec).length > 0;

    const check = (entry: unknown, block: 'jobs' | 'cron', index: number): void => {
        const item = entry as { name?: string; component?: string; http?: unknown } | null;
        if (item === null || item === undefined || item.http === undefined || item.http === null)
            return;
        const resolved = resolvedComponentName(spec, item.component);
        const target = resolved === null ? undefined : byName.get(resolved);
        if (target !== undefined && target.role === 'web') return;
        if (target === undefined && resolved !== null) return; // R14's `component_ref_unknown`
        if (target === undefined && anyWeb) return; // the default resolves to a web component
        findings.push(
            finding(
                ctx,
                spec,
                'http_job_requires_web_component',
                'error',
                pointerOf([block, index, 'component']),
                {
                    [block === 'jobs' ? 'job' : 'cron']: item.name ?? '',
                    ...(resolved === null ? {} : { component: resolved }),
                },
            ),
        );
    };

    const jobs = Array.isArray(spec?.jobs) ? spec.jobs : [];
    const cron = Array.isArray(spec?.cron) ? spec.cron : [];
    jobs.forEach((job, index) => check(job, 'jobs', index));
    cron.forEach((entry, index) => check(entry, 'cron', index));
    return findings;
}

/** `public_bucket_undeclared` — §11:226: `publicBuckets` is a subset of `buckets`. */
export function checkPublicBucketUndeclared(
    spec: AppSpec,
    ctx: RuleContext = {},
): readonly AppSpecRuleFinding[] {
    const storage = spec?.dependencies?.objectStorage;
    const declared = Array.isArray(storage?.buckets) ? storage.buckets : [];
    const publicBuckets = Array.isArray(storage?.publicBuckets) ? storage.publicBuckets : [];
    const findings: AppSpecRuleFinding[] = [];
    publicBuckets.forEach((bucket, index) => {
        if (declared.includes(bucket)) return;
        findings.push(
            finding(
                ctx,
                spec,
                'public_bucket_undeclared',
                'error',
                pointerOf(['dependencies', 'objectStorage', 'publicBuckets', index]),
                { bucket },
            ),
        );
    });
    return findings;
}

/** `generated_not_secret` — §12:253: "`generate` … Implies `secret: true`". */
export function checkGeneratedNotSecret(
    spec: AppSpec,
    ctx: RuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    envEntriesOf(spec).forEach((entry, index) => {
        if (entry?.generate === undefined || entry.generate === null) return;
        if (entry.secret === true) return;
        findings.push(
            finding(
                ctx,
                spec,
                'generated_not_secret',
                'error',
                pointerOf(['env', index, 'secret']),
                {
                    entry: entry.name ?? '',
                },
            ),
        );
    });
    return findings;
}

/**
 * `prompt_example_secret` — §12:255: `prompt.example` is "≤ 200 (secret-scanned:
 * `prompt_example_secret`)".
 *
 * The example's **value is never echoed** (§23:534, FR-6): the finding carries
 * the entry name and nothing else, and the message says only that the example
 * looks like a credential.
 */
export function checkPromptExampleSecret(
    spec: AppSpec,
    ctx: RuleContext = {},
): readonly AppSpecRuleFinding[] {
    const findings: AppSpecRuleFinding[] = [];
    envEntriesOf(spec).forEach((entry, index) => {
        const example = entry?.prompt?.example;
        if (typeof example !== 'string' || example.length === 0) return;
        if (scanForSecrets(example).length === 0) return;
        findings.push(
            finding(
                ctx,
                spec,
                'prompt_example_secret',
                'error',
                pointerOf(['env', index, 'prompt', 'example']),
                { entry: entry.name ?? '' },
            ),
        );
    });
    return findings;
}

/** The six structural cross-field codes of §23 that T5 deliberately left to T6. */
export const APP_SPEC_STRUCTURAL_RULES: readonly AppSpecStructuralRule[] = [
    { name: 'worker_port_forbidden', codes: ['worker_port_forbidden'], evaluate: checkWorkerPort },
    {
        name: 'worker_probe_without_port',
        codes: ['worker_probe_without_port'],
        evaluate: checkWorkerProbeWithoutPort,
    },
    {
        name: 'http_job_requires_web_component',
        codes: ['http_job_requires_web_component'],
        evaluate: checkHttpJobRequiresWebComponent,
    },
    {
        name: 'public_bucket_undeclared',
        codes: ['public_bucket_undeclared'],
        evaluate: checkPublicBucketUndeclared,
    },
    {
        name: 'generated_not_secret',
        codes: ['generated_not_secret'],
        evaluate: checkGeneratedNotSecret,
    },
    {
        name: 'prompt_example_secret',
        codes: ['prompt_example_secret'],
        evaluate: checkPromptExampleSecret,
    },
];

// ---------------------------------------------------------------------------
// The server-only rules (§22:483-488) — the five T5 left to T6
// ---------------------------------------------------------------------------

/**
 * `source_relation_mismatch` — §5:128-129: "`relation` must equal the relation
 * recorded when the App Work was created (error `source_relation_mismatch`) — a
 * hand edit cannot turn a fork into a link."
 *
 * `recordedRelation` absent or `null` is unknown, so the rule is skipped
 * (§22:502) and an absent `source` block is left to `required`.
 */
export function checkSourceRelation(
    spec: AppSpec,
    ctx: RuleContext = {},
): readonly AppSpecRuleFinding[] {
    const recorded: AppSpecSourceRelation | null = ctx.recordedRelation ?? null;
    if (recorded === null) return [];
    const declared = spec?.source?.relation;
    if (declared === undefined || declared === null) return [];
    if (declared === recorded) return [];
    return [
        finding(ctx, spec, 'source_relation_mismatch', 'error', pointerOf(['source', 'relation']), {
            recorded,
            declared,
        }),
    ];
}

/**
 * `blueprint_unknown` — §6:142: "an `id` the Apps catalog does not list is
 * warning `blueprint_unknown` (upgrade notices stop)".
 *
 * `catalogUnavailable: true` suppresses it *instead of* reporting it (§22:497):
 * a catalog that could not be read is not evidence that the Blueprint is gone.
 */
export function checkBlueprintKnown(
    spec: AppSpec,
    ctx: RuleContext = {},
): readonly AppSpecRuleFinding[] {
    if (ctx.catalogUnavailable === true) return [];
    const ids = ctx.catalogIds ?? null;
    if (ids === null) return [];
    const id = spec?.blueprint?.id;
    if (typeof id !== 'string' || id.length === 0) return [];
    if (ids.includes(id)) return [];
    return [
        finding(ctx, spec, 'blueprint_unknown', 'warning', pointerOf(['blueprint', 'id']), { id }),
    ];
}

/** The strategies that actually name a builder — §22:504-505, §9:181-186. */
export const APP_SPEC_BUILDER_STRATEGIES = ['dockerfile', 'auto'] as const;

/**
 * `build_strategy_unavailable` — §9:185-186: "When no enabled build plugin lists
 * `auto` among its supported strategies, the server-only warning
 * `build_strategy_unavailable` is reported".
 *
 * §22:504-505 narrows it to the strategies that name a builder: "`image` and
 * `none` name no builder, so an empty plugin list never warns about them."
 * `buildStrategies: null` — no build plugin enabled, or nothing resolved yet — is
 * **unknown** and skips the rule.
 */
export function checkBuildStrategyAvailable(
    spec: AppSpec,
    ctx: RuleContext = {},
): readonly AppSpecRuleFinding[] {
    const strategies = ctx.buildStrategies ?? null;
    if (strategies === null) return [];
    const strategy = spec?.build?.strategy;
    if (strategy === undefined || strategy === null) return [];
    if (!(APP_SPEC_BUILDER_STRATEGIES as readonly string[]).includes(strategy)) return [];
    if (strategies.includes(strategy)) return [];
    return [
        finding(
            ctx,
            spec,
            'build_strategy_unavailable',
            'warning',
            pointerOf(['build', 'strategy']),
            {
                strategy,
            },
        ),
    ];
}

/** The dependency kinds §11 declares, in the order its table prints them. */
export const APP_SPEC_DEPENDENCY_KINDS = ['postgres', 'redis', 'objectStorage', 'smtp'] as const;

/**
 * The kinds the providers for the Work's target support, or `null` when unknown.
 *
 * §22:499 — "`dependencyProviders` … providers by kind for the Work's deploy
 * target, or `null` when unknown". Two shapes are accepted because both are
 * useful and neither is ambiguous: target-keyed
 * (`{ 'ever-works-apps': { postgres: true } }`, read with
 * {@link RuleContext.deployTarget}) and flat (`{ postgres: true }`, which is what
 * a caller that already resolved the target naturally has). A target-keyed map
 * with no entry for the target is **unknown** for that target — never "nothing is
 * available".
 */
function providerKindsFor(ctx: RuleContext): Readonly<Record<string, boolean>> | null {
    const providers = ctx.dependencyProviders ?? null;
    if (providers === null) return null;
    const record = providers as Readonly<Record<string, unknown>>;

    const target = ctx.deployTarget ?? null;
    if (typeof target === 'string' && target.length > 0) {
        const scoped = record[target];
        if (isPlainObject(scoped)) return scoped as Readonly<Record<string, boolean>>;
    }

    const values = Object.values(record);
    if (values.length > 0 && values.every((value) => typeof value === 'boolean')) {
        return record as Readonly<Record<string, boolean>>;
    }
    return null;
}

/**
 * `dependency_unavailable` — §11 and §22:487: "no enabled `app-dependency`
 * provider for the kind on the selected target — warning".
 *
 * A kind the provider map does not answer `true` for is unavailable; a kind the
 * map never mentions is reported too, because the map *is* the answer for that
 * target. An unknown map — `null`, or one keyed by a target nobody named — skips
 * the rule entirely.
 */
export function checkDependencyAvailable(
    spec: AppSpec,
    ctx: RuleContext = {},
): readonly AppSpecRuleFinding[] {
    const kinds = providerKindsFor(ctx);
    if (kinds === null) return [];
    const dependencies = spec?.dependencies;
    if (dependencies === undefined || dependencies === null) return [];

    const findings: AppSpecRuleFinding[] = [];
    for (const kind of APP_SPEC_DEPENDENCY_KINDS) {
        if (dependencies[kind] === undefined || dependencies[kind] === null) continue;
        if (kinds[kind] === true) continue;
        findings.push(
            finding(
                ctx,
                spec,
                'dependency_unavailable',
                'warning',
                pointerOf(['dependencies', kind]),
                {
                    kind,
                    ...(typeof ctx.deployTarget === 'string' && ctx.deployTarget.length > 0
                        ? { target: ctx.deployTarget }
                        : {}),
                },
            ),
        );
    }
    return findings;
}

/**
 * `tracked_branch_missing` — §22:500 and plan §2.3:199-201: the tracked branch
 * could not be read (`trackedBranchExists: false`), so the spec on it cannot be
 * evaluated.
 *
 * The issue points at `source.branch` — the key that would move the tracked
 * branch (FR-16) — and names the branch the spec declares, falling back to the
 * upstream default. `true` and `null` are both "nothing to report", which is
 * §22:502's rule in one line.
 */
export function checkTrackedBranch(
    spec: AppSpec,
    ctx: RuleContext = {},
): readonly AppSpecRuleFinding[] {
    if (ctx.trackedBranchExists !== false) return [];
    const branch = spec?.source?.branch;
    const upstream = spec?.source?.upstream?.defaultBranch;
    const named = typeof branch === 'string' && branch.length > 0 ? branch : upstream;
    const params: Record<string, string> = {};
    if (typeof named === 'string' && named.length > 0) params.branch = named;
    return [
        finding(
            ctx,
            spec,
            'tracked_branch_missing',
            'error',
            pointerOf(['source', 'branch']),
            params,
        ),
    ];
}

/**
 * `extension_unavailable` — §11:221: "Availability is provider-specific (warning
 * `extension_unavailable`)".
 *
 * §22:483-488 names the code but no input, so
 * {@link RuleContext.postgresExtensions} carries the provider's list; absent or
 * `null` is unknown and skips the rule (§22:502).
 */
export function checkPostgresExtensions(
    spec: AppSpec,
    ctx: RuleContext = {},
): readonly AppSpecRuleFinding[] {
    const available = ctx.postgresExtensions ?? null;
    if (available === null) return [];
    const declared = spec?.dependencies?.postgres?.extensions;
    if (!Array.isArray(declared)) return [];
    const findings: AppSpecRuleFinding[] = [];
    declared.forEach((extension, index) => {
        if (available.includes(extension)) return;
        findings.push(
            finding(
                ctx,
                spec,
                'extension_unavailable',
                'warning',
                pointerOf(['dependencies', 'postgres', 'extensions', index]),
                { extension },
            ),
        );
    });
    return findings;
}

/** §22:483-488's server-only codes, as the registry T6 runs. */
export const APP_SPEC_SERVER_ONLY_RULES: readonly AppSpecServerOnlyRule[] = [
    {
        name: 'source_relation_mismatch',
        code: 'source_relation_mismatch',
        severity: 'error',
        evaluate: checkSourceRelation,
    },
    {
        name: 'blueprint_unknown',
        code: 'blueprint_unknown',
        severity: 'warning',
        evaluate: checkBlueprintKnown,
    },
    {
        name: 'build_strategy_unavailable',
        code: 'build_strategy_unavailable',
        severity: 'warning',
        evaluate: checkBuildStrategyAvailable,
    },
    {
        name: 'dependency_unavailable',
        code: 'dependency_unavailable',
        severity: 'warning',
        evaluate: checkDependencyAvailable,
    },
    {
        name: 'tracked_branch_missing',
        code: 'tracked_branch_missing',
        severity: 'error',
        evaluate: checkTrackedBranch,
    },
    {
        name: 'extension_unavailable',
        code: 'extension_unavailable',
        severity: 'warning',
        evaluate: checkPostgresExtensions,
    },
];

// ---------------------------------------------------------------------------
// Building one finding
// ---------------------------------------------------------------------------

/**
 * One finding, with the position of its key or of the nearest key that exists.
 *
 * Mirrors T5's private `issue()` so that a finding from this module and one from
 * `app-spec.rules.ts` are indistinguishable downstream: same pointer spelling,
 * same `path` derivation, same `displayPath` rule, same position fallback
 * (§23:532-533).
 */
function finding(
    ctx: RuleContext,
    spec: AppSpec,
    code: AppSpecIssueCode,
    severity: AppSpecSeverity,
    pointer: string,
    params?: AppSpecIssueParams,
): AppSpecRuleFinding {
    const position = nearestPosition(pointer, ctx.positions);
    return {
        code,
        severity,
        pointer,
        path: pointerToPath(pointer),
        displayPath: displayPathFor(spec, pointer),
        ...(position === null ? {} : { line: position.line, column: position.column }),
        ...(params === undefined ? {} : { params }),
    };
}

// ---------------------------------------------------------------------------
// The pointer → position map (plan §2.2:135)
// ---------------------------------------------------------------------------

/** The position of the document root — the fallback §23:533 needs to always answer. */
const ROOT_POSITION: AppSpecRulePosition = { line: 1, column: 1 };

/** The pointer that spells the document root itself — no key at all. */
const DOCUMENT_POINTER = '';

/**
 * Build the `JSON pointer → {line, column}` map from a parsed YAML document.
 *
 * **Keys only.** §23:533 says `line`/`column` "point at the key when present,
 * else at the nearest parent key", so the map holds one entry per mapping key
 * (`item.key.range` → `LineCounter.linePos`); a pointer to an array element or to
 * an absent key then falls back through its ancestors — `components[0].port` on a
 * component with no `port` resolves to the `components` key, which is the parent
 * key §23:533 asks for.
 */
function buildPositions(
    document: unknown,
    counter: LineCounter,
): ReadonlyMap<string, AppSpecRulePosition> {
    const map = new Map<string, AppSpecRulePosition>();

    const positionAt = (offset: number): AppSpecRulePosition | null => {
        try {
            const position = counter.linePos(offset);
            return { line: position.line, column: position.col };
        } catch {
            return null;
        }
    };

    const walk = (node: unknown, pointer: string): void => {
        if (isMap(node)) {
            for (const item of node.items) {
                if (!isScalar(item.key)) continue;
                const child = `${pointer}/${String(item.key.value)}`;
                const range = item.key.range;
                if (range !== undefined && range !== null) {
                    const position = positionAt(range[0]);
                    if (position !== null) map.set(child, position);
                }
                walk(item.value, child);
            }
            return;
        }
        if (isSeq(node)) {
            node.items.forEach((item, index) => walk(item, `${pointer}/${index}`));
        }
    };

    walk(document, '');
    return map;
}

/** The lookup T5's `nearestPosition` asks, over {@link buildPositions}. */
function lookupFor(map: ReadonlyMap<string, AppSpecRulePosition>): AppSpecRulePositionLookup {
    return (pointer) => map.get(pointer) ?? null;
}

// ---------------------------------------------------------------------------
// Mapping zod issues onto §23 codes
// ---------------------------------------------------------------------------

/** One structural problem, before it becomes an {@link AppSpecIssue}. */
interface StructuralFinding {
    readonly code: AppSpecIssueCode;
    readonly severity: AppSpecSeverity;
    readonly pointer: string;
    readonly params?: AppSpecIssueParams;
}

/**
 * The two paths whose shape failure is **T5's** `cron_invalid`, not a structural
 * `pattern`.
 *
 * §14:339 — "`cron_invalid` when unparsable" — and a four-field expression is
 * exactly that. T5 reports it from the expression's text, so this layer neither
 * publishes `pattern` here nor lets the repair loop delete the value for good:
 * see {@link restoreDeferred}.
 */
const DEFERRED_SCHEDULE_POINTERS: readonly RegExp[] = [
    /^\/spec\/cron\/\d+\/schedule$/,
    /^\/spec\/upstreamSync\/schedule$/,
];

/** Is this pointer's failure reported by a later layer rather than here? */
function isDeferredPointer(pointer: string): boolean {
    return DEFERRED_SCHEDULE_POINTERS.some((pattern) => pattern.test(pointer));
}

/**
 * What a deferred path is set to so the repair loop stops there.
 *
 * A syntactically valid five-field cron (§14:339). Deleting the author's text is
 * what would cascade — a required key that has just been deleted is reported
 * again, and the round after that removes the whole `cron[]` entry — so the value
 * is **replaced** instead, and {@link restoreDeferred} puts the real text back
 * before the rules read it.
 */
const DEFERRED_PLACEHOLDER = '0 0 1 1 0';

/**
 * The JSON Schema `z.toJSONSchema(appSpecSchema)` produces, built once.
 *
 * It is the **allowed-key table** `unknown_field`'s suggestion needs: the schema
 * inlines every subschema (no `$ref`), so walking `properties` / `items` by path
 * answers "which keys are defined at this object level?" without this module
 * keeping a hand-written copy of §5–§20 that could drift from T3's schema. The
 * same idiom `emit-json-schema.ts:26` uses.
 *
 * Built lazily and guarded: it is needed only when an unknown key is actually
 * reported, and a build that cannot produce it must cost a *suggestion*, never a
 * throw (FR-8).
 */
let allowedKeysSchema: unknown | undefined;
let allowedKeysSchemaUnavailable = false;

/** The keys defined at the object level `path` reaches, or `[]` when unknown. */
function allowedKeysAt(path: readonly (string | number)[]): readonly string[] {
    if (allowedKeysSchema === undefined && !allowedKeysSchemaUnavailable) {
        try {
            allowedKeysSchema = z.toJSONSchema(appSpecSchema, { io: 'input' });
        } catch {
            allowedKeysSchemaUnavailable = true;
        }
    }
    if (allowedKeysSchema === undefined) return [];

    let node: unknown = allowedKeysSchema;
    for (const segment of path) {
        if (node === null || typeof node !== 'object') return [];
        const record = node as { properties?: Record<string, unknown>; items?: unknown };
        node =
            typeof segment === 'number' || /^\d+$/.test(String(segment))
                ? record.items
                : record.properties?.[String(segment)];
    }
    if (node === null || typeof node !== 'object') return [];
    const properties = (node as { properties?: Record<string, unknown> }).properties;
    return properties === undefined ? [] : Object.keys(properties);
}

/** Everything {@link structuralFindingFor} needs beyond the issue itself. */
interface StructuralMapping {
    /** The `appSpecVersion` the document declares, when it is above this build's. */
    readonly newerVersion: number | null;
    /** The `spec.kind` the document actually spelled, when it spelled one. */
    readonly declaredKind: string | null;
    /** The root `kind`, when the caller could supply one. */
    readonly rootKind: string | null;
}

/** One unknown key, expanded from a zod `unrecognized_keys` issue (§2.2:138). */
function unknownFieldFor(
    key: string,
    parent: readonly (string | number)[],
    mapping: StructuralMapping,
): StructuralFinding {
    const pointer = pointerOf([...parent, key]);
    const suggestion = suggestKey(key, allowedKeysAt(parent));
    if (mapping.newerVersion === null) {
        return {
            code: 'unknown_field',
            severity: 'error',
            pointer,
            params: { key, ...(suggestion === null ? {} : { suggestion }) },
        };
    }
    return {
        code: 'unknown_field_newer_version',
        severity: 'warning',
        pointer,
        params: {
            key,
            ...(suggestion === null ? {} : { suggestion }),
            appSpecVersion: mapping.newerVersion,
            supported: APP_SPEC_SUPPORTED_VERSION,
        },
    };
}

/**
 * Translate one zod issue into a §23 structural finding, or `null`.
 *
 * The mapping follows §5 of `validator-rules.md` (the build artifact's
 * "Layer-1 keyword → `APP_SPEC_ISSUE_CODES`" table), narrowed to what T6 owns:
 * the codes T4 and T5 already emit — `reference_syntax`, `cron_invalid`,
 * `pattern_unsupported`, `template_cycle`, `template_too_deep` and every rule
 * code — are **not** produced here, or one leaf would get two reports
 * (§22:511-513).
 */
function structuralFindingFor(
    issue: z.core.$ZodIssue,
    mapping: StructuralMapping,
): StructuralFinding | null {
    const path = issue.path as readonly (string | number)[];
    const pointer = pointerOf(path);
    const key = path.length === 0 ? null : String(path[path.length - 1]);
    const withKey = (extra?: AppSpecIssueParams): AppSpecIssueParams => ({
        ...(key === null ? {} : { key }),
        ...(extra ?? {}),
    });

    switch (issue.code) {
        // Expanded by the caller, one `unknown_field` per key.
        case 'unrecognized_keys':
            return null;

        case 'invalid_type':
            return {
                code: 'invalid_type',
                severity: 'error',
                pointer,
                params: withKey(
                    typeof issue.expected === 'string' ? { expected: issue.expected } : undefined,
                ),
            };

        case 'invalid_value': {
            // §1:64 — the two spellings of `kind` must agree. zod's `literal('app')`
            // reports the *allowed* value, so the declared one comes from the
            // document (see `StructuralMapping.declaredKind`).
            if (path.length === 1 && path[0] === 'kind') {
                return {
                    code: 'kind_mismatch',
                    severity: 'error',
                    pointer,
                    params: {
                        ...(mapping.declaredKind === null
                            ? {}
                            : { declared: mapping.declaredKind }),
                        ...(mapping.rootKind === null ? {} : { root: mapping.rootKind }),
                    },
                };
            }
            const values = Array.isArray(issue.values) ? issue.values : [];
            return {
                code: 'invalid_enum',
                severity: 'error',
                pointer,
                params: withKey(
                    values.length === 0
                        ? undefined
                        : { allowed: values.map((value) => JSON.stringify(value)).join(', ') },
                ),
            };
        }

        case 'too_small':
        case 'too_big':
        case 'not_multiple_of': {
            const bound =
                'minimum' in issue && typeof issue.minimum === 'number'
                    ? issue.minimum
                    : 'maximum' in issue && typeof issue.maximum === 'number'
                      ? issue.maximum
                      : null;
            return {
                code: 'out_of_range',
                severity: 'error',
                pointer,
                params: withKey(bound === null ? undefined : { limit: bound }),
            };
        }

        case 'invalid_format': {
            if (isDeferredPointer(pointer)) return null; // T5's `cron_invalid`
            if (/^\/spec\/blueprint\/repo$/.test(pointer)) {
                return { code: 'blueprint_repo_outside_org', severity: 'error', pointer };
            }
            return { code: 'pattern', severity: 'error', pointer, params: withKey() };
        }

        default:
            return { code: 'invalid_type', severity: 'error', pointer, params: withKey() };
    }
}

// ---------------------------------------------------------------------------
// The best-effort copy the rules read (§22:509-513)
// ---------------------------------------------------------------------------

/** How many repair rounds are attempted before the rules are given up on. */
const MAX_REPAIR_ROUNDS = 16;

/** Remove the value at `path`: a key from a mapping, an element from a sequence. */
function removeAt(root: unknown, path: readonly (string | number)[]): boolean {
    if (path.length === 0) return false;

    let node: unknown = root;
    for (const segment of path.slice(0, -1)) {
        if (Array.isArray(node)) {
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0 || index >= node.length) return false;
            node = node[index];
            continue;
        }
        if (!isPlainObject(node)) return false;
        if (!Object.prototype.hasOwnProperty.call(node, String(segment))) return false;
        node = node[String(segment)];
    }

    const last = path[path.length - 1];
    if (Array.isArray(node)) {
        const index = Number(last);
        if (!Number.isInteger(index) || index < 0 || index >= node.length) return false;
        node.splice(index, 1);
        return true;
    }
    if (!isPlainObject(node)) return false;
    if (!Object.prototype.hasOwnProperty.call(node, String(last))) return false;
    delete node[String(last)];
    return true;
}

/** Read the value at `path`, or `undefined`. */
function readAt(root: unknown, path: readonly (string | number)[]): unknown {
    let node: unknown = root;
    for (const segment of path) {
        if (Array.isArray(node)) {
            node = node[Number(segment)];
            continue;
        }
        if (!isPlainObject(node)) return undefined;
        node = node[String(segment)];
    }
    return node;
}

/**
 * Put `value` back at `path`, creating the key when the repair removed it.
 *
 * Setting the key is the point: {@link restoreDeferred} exists precisely because
 * {@link removeAt} deleted a `schedule` the rules still have to read. The path
 * always comes from the repair's own record, so nothing is invented.
 */
function writeAt(root: unknown, path: readonly (string | number)[], value: unknown): boolean {
    if (path.length === 0) return false;
    let node: unknown = root;
    for (const segment of path.slice(0, -1)) {
        if (Array.isArray(node)) {
            node = node[Number(segment)];
            continue;
        }
        if (!isPlainObject(node)) return false;
        node = node[String(segment)];
    }
    const last = path[path.length - 1];
    if (Array.isArray(node)) {
        const index = Number(last);
        if (!Number.isInteger(index) || index < 0 || index >= node.length) return false;
        node[index] = value;
        return true;
    }
    if (!isPlainObject(node)) return false;
    node[String(last)] = value;
    return true;
}

/** What the repair loop produced. */
interface RepairResult {
    /** The parsed copy the rules read, or `null` when the document could not be repaired. */
    readonly spec: AppSpec | null;
    /** Every pointer the repair removed — the leaves the rules must not judge. */
    readonly pruned: readonly string[];
}

/**
 * Build the best-effort copy R1–R27 read (§22:509-511).
 *
 * The loop parses, removes what the parse objected to, and parses again: an
 * `unrecognized_keys` issue loses each named key, and any other failure loses the
 * failing leaf — or, when the leaf is an array element whose removal would shift
 * its neighbours out of the positions the rules report, the nearest enclosing
 * element. What it removed is returned so the caller can drop the rule findings
 * that read it, which is how "a single invalid leaf never produces a duplicate
 * report" (§22:511-513) is enforced mechanically.
 *
 * Bounded by {@link MAX_REPAIR_ROUNDS} **and** by progress: a document the loop
 * cannot turn into a parse returns `spec: null`, the rules do not run, and the
 * caller records that (§22:513, FR-83).
 */
function repairForRules(input: unknown): RepairResult {
    // `stripExtensionKeys` rebuilds every mapping and array, so its result is
    // also a safe deep clone (an own `__proto__` key stays an own key).
    const working = stripExtensionKeys(input);
    const pruned = new Set<string>();
    let parsed = appSpecSchema.safeParse(working);

    for (let round = 0; !parsed.success && round < MAX_REPAIR_ROUNDS; round += 1) {
        let changed = false;

        for (const issue of parsed.error.issues) {
            const path = issue.path as readonly (string | number)[];

            if (issue.code === 'unrecognized_keys') {
                for (const key of issue.keys) {
                    if (!removeAt(working, [...path, key])) continue;
                    pruned.add(pointerOf([...path, key]));
                    changed = true;
                }
                continue;
            }

            if (path.length === 0) continue; // the block itself is unusable — no repair, no rules

            // A deferred path is T5's to report, so it is neutralised rather than
            // deleted: removing a required key here would cascade into a second
            // failure and take the whole `cron[]` entry with it.
            if (isDeferredPointer(pointerOf(path))) {
                if (!writeAt(working, path, DEFERRED_PLACEHOLDER)) continue;
                pruned.add(pointerOf(path));
                changed = true;
                continue;
            }

            if (removeAt(working, path)) {
                pruned.add(pointerOf(path));
                changed = true;
                continue;
            }
            for (let cut = path.length - 2; cut >= 0; cut -= 1) {
                const ancestor = path.slice(0, cut + 1);
                if (!removeAt(working, ancestor)) continue;
                pruned.add(pointerOf(ancestor));
                changed = true;
                break;
            }
        }

        if (!changed) break;
        parsed = appSpecSchema.safeParse(working);
    }

    return parsed.success && parsed.data !== undefined
        ? { spec: parsed.data as AppSpec, pruned: [...pruned] }
        : { spec: null, pruned: [...pruned] };
}

/**
 * Put the values of {@link DEFERRED_SCHEDULE_POINTERS} back into the copy.
 *
 * The repair loop deletes a four-field `cron` expression to reach a parse, but
 * T5 is the layer that reports it (`cron_invalid`) and it can only judge a value
 * it can see. Restoring it costs nothing structurally — the value is a string
 * either way — and both of T5's readers of `schedule` guard on the type and
 * catch a parse failure.
 */
function restoreDeferred(spec: AppSpec, pristine: unknown, pointers: readonly string[]): AppSpec {
    for (const pointer of pointers) {
        const path = pathOf(pointer);
        const value = readAt(pristine, path);
        if (value === undefined) continue;
        writeAt(spec, path, value);
    }
    return spec;
}

// ---------------------------------------------------------------------------
// Running the rules
// ---------------------------------------------------------------------------

/** Every rule label this validator knows, for FR-83's "say which". */
export const APP_SPEC_ALL_RULE_LABELS: readonly string[] = [
    ...APP_SPEC_RULES.map((rule) => rule.id),
    ...APP_SPEC_DOCUMENT_CHECKS.map((check) => check.name),
    ...APP_SPEC_STRUCTURAL_RULES.map((rule) => rule.name),
    ...APP_SPEC_SERVER_ONLY_RULES.map((rule) => rule.name),
];

/** Is a finding on a pointer the repair removed, or inside such a container? */
function isSuppressed(pointer: string, pruned: ReadonlySet<string>): boolean {
    for (const removed of pruned) {
        if (pointer === removed || pointer.startsWith(`${removed}/`)) return true;
    }
    return false;
}

/** Run one rule, treating a rule that cannot judge this document as reporting nothing. */
function safeEvaluate(
    evaluate: () => readonly AppSpecRuleFinding[],
): readonly AppSpecRuleFinding[] {
    try {
        return evaluate();
    } catch {
        return [];
    }
}

/** One rule run, with the findings it produced and whether any were dropped. */
interface RuleRun {
    readonly label: string;
    readonly findings: readonly AppSpecRuleFinding[];
    readonly suppressed: boolean;
}

/**
 * Run every rule over the repaired copy.
 *
 * T5's engine is called through its own entry point — `evaluateAppSpecRules` —
 * so this module never re-implements one of its rules; the six structural and six
 * server-only rules of §22:483-488 are T6's and are appended after it.
 *
 * **Provenance** is computed only when something *was* suppressed: each rule is
 * then run on its own, through the exported `APP_SPEC_RULES` /
 * `APP_SPEC_DOCUMENT_CHECKS` definitions rather than a copy of their logic, so
 * FR-83's "the response MUST say which" can name them. A document with no
 * structural problem — the overwhelmingly common case — pays nothing for it.
 */
function runRules(
    spec: AppSpec,
    ctx: RuleContext,
    pruned: ReadonlySet<string>,
): {
    readonly findings: readonly AppSpecRuleFinding[];
    readonly suppressedRules: readonly string[];
} {
    const runs: RuleRun[] = [];

    const evaluateAll = (): readonly AppSpecRuleFinding[] => [
        ...safeEvaluate(() => evaluateAppSpecRules(spec, ctx)),
        ...APP_SPEC_STRUCTURAL_RULES.flatMap((rule) =>
            safeEvaluate(() => rule.evaluate(spec, ctx)),
        ),
        ...APP_SPEC_SERVER_ONLY_RULES.flatMap((rule) =>
            safeEvaluate(() => rule.evaluate(spec, ctx)),
        ),
    ];

    const all = evaluateAll();
    const findings = all.filter((item) => !isSuppressed(item.pointer, pruned));
    if (findings.length === all.length) return { findings, suppressedRules: [] };

    const label = (name: string, produced: readonly AppSpecRuleFinding[]): void => {
        if (produced.length === 0) return;
        runs.push({
            label: name,
            findings: produced,
            suppressed: produced.some((item) => isSuppressed(item.pointer, pruned)),
        });
    };

    for (const rule of APP_SPEC_RULES) {
        label(
            rule.id,
            safeEvaluate(() => rule.evaluate(spec, ctx)),
        );
    }
    for (const check of APP_SPEC_DOCUMENT_CHECKS) {
        label(
            check.name,
            safeEvaluate(() => check.evaluate(spec, ctx)),
        );
    }
    for (const rule of APP_SPEC_STRUCTURAL_RULES) {
        label(
            rule.name,
            safeEvaluate(() => rule.evaluate(spec, ctx)),
        );
    }
    for (const rule of APP_SPEC_SERVER_ONLY_RULES) {
        label(
            rule.name,
            safeEvaluate(() => rule.evaluate(spec, ctx)),
        );
    }

    return {
        findings,
        suppressedRules: runs.filter((run) => run.suppressed).map((run) => run.label),
    };
}

// ---------------------------------------------------------------------------
// Issue assembly, sort and cap
// ---------------------------------------------------------------------------

/** The severity order the sort uses — errors first (§2.2:141). */
const SEVERITY_RANK: Readonly<Record<AppSpecSeverity, number>> = { error: 0, warning: 1 };

/** One assembled issue, plus the input order the sort falls back to. */
interface OrderedIssue {
    readonly issue: AppSpecIssue;
    readonly index: number;
}

/**
 * One published issue from a finding: §23's object, with `message` and `hint`
 * from {@link describeIssue} and a position from the pointer map.
 *
 * `line`/`column` are absent when the caller had no YAML to look at
 * (`validateAppSpecObject`, plan §2.2:144). In the document form the root
 * fallback keeps FR-5's "every problem carries a line and column" true even for a
 * problem on an absent key.
 */
function toIssue(item: AppSpecRuleFinding, lookup: AppSpecRulePositionLookup | null): AppSpecIssue {
    const position =
        item.line === undefined
            ? lookup === null
                ? null
                : (nearestPosition(item.pointer, lookup) ?? ROOT_POSITION)
            : { line: item.line, column: item.column ?? 1 };
    const displayPath =
        item.pointer === DOCUMENT_POINTER
            ? 'works.yml'
            : item.displayPath.length > 0
              ? item.displayPath
              : pointerToPath(item.pointer);
    const { message, hint } = describeIssue(item.code, item.params);

    return {
        code: item.code,
        severity: item.severity,
        path: item.path,
        pointer: item.pointer,
        displayPath,
        ...(position === null ? {} : { line: position.line, column: position.column }),
        message,
        ...(hint === undefined ? {} : { hint }),
        ...(item.params === undefined ? {} : { params: item.params }),
    };
}

/** Errors first, then line, then column, then the order the layers produced. */
function sortIssues(issues: readonly OrderedIssue[]): readonly AppSpecIssue[] {
    const far = Number.MAX_SAFE_INTEGER;
    return [...issues]
        .sort(
            (a, b) =>
                SEVERITY_RANK[a.issue.severity] - SEVERITY_RANK[b.issue.severity] ||
                (a.issue.line ?? far) - (b.issue.line ?? far) ||
                (a.issue.column ?? far) - (b.issue.column ?? far) ||
                a.index - b.index,
        )
        .map((entry) => entry.issue);
}

/** Assemble, sort and cap one result. Never throws. */
function assemble(
    findings: readonly AppSpecRuleFinding[],
    spec: AppSpec | null,
    lookup: AppSpecRulePositionLookup | null,
    rulesRan: boolean,
    suppressedRules: readonly string[],
): AppSpecValidationResult {
    const ordered: OrderedIssue[] = [];
    const issues: AppSpecIssue[] = [];
    findings.forEach((item, index) => {
        try {
            const issue = toIssue(item, lookup);
            ordered.push({ issue, index });
            issues.push(issue);
        } catch {
            /* one unrenderable finding must not take the whole response down (FR-8) */
        }
    });

    const sorted = sortIssues(ordered);
    const truncated = sorted.length > APP_SPEC_MAX_ISSUES;
    const errorCount = issues.filter((issue) => issue.severity === 'error').length;
    const warningCount = issues.filter((issue) => issue.severity === 'warning').length;

    return {
        status: errorCount > 0 ? 'invalid' : warningCount > 0 ? 'valid_with_warnings' : 'valid',
        issues: truncated ? sorted.slice(0, APP_SPEC_MAX_ISSUES) : sorted,
        errorCount,
        warningCount,
        truncated,
        // FR-20: only a document with zero errors is a spec a caller may use.
        spec: errorCount === 0 ? spec : null,
        rulesRan,
        suppressedRules,
    };
}

// ---------------------------------------------------------------------------
// The pipeline both entry points share
// ---------------------------------------------------------------------------

/** Everything the shared pipeline needs, already extracted from text or an object. */
interface PipelineInput {
    /** The `spec` block as the caller held it (`x-` keys still present), or `null` when absent. */
    readonly specBlock: unknown;
    readonly lookup: AppSpecRulePositionLookup | null;
    readonly rootKind: string | null;
    /**
     * One of the four inputs of §22:508 that stop the document from parsing —
     * `yaml_syntax`, `file_too_large`, `yaml_alias_limit`, the depth limit. Only
     * these suppress the rule set.
     */
    readonly fatal: StructuralFinding | null;
    /**
     * An envelope problem that leaves no block to run the rules on — the root is
     * not a mapping, or there is no `spec`. Reported like any other structural
     * finding, and the rules still run (over an empty block, which reports
     * nothing) so that §22:508's "only these four suppress the rule set" stays
     * literally true.
     */
    readonly envelope?: StructuralFinding | null;
    /** Structural findings the document path already knows (duplicate keys). */
    readonly leading: readonly StructuralFinding[];
}

/** The mode a caller asked for, after alias resolution and with the default applied. */
function normaliseMode(mode: AppSpecValidationOptions['mode']): AppSpecValidationMode {
    if (typeof mode !== 'string' || mode.length === 0) return 'data-repository';
    const alias = APP_SPEC_VALIDATOR_MODE_ALIASES[mode];
    if (alias !== undefined) return alias;
    return (APP_SPEC_VALIDATOR_MODES as readonly string[]).includes(mode)
        ? (mode as AppSpecValidationMode)
        : 'data-repository';
}

/** The `appSpecVersion` a block declares, when it declares a usable one. */
function versionOf(value: unknown): number | null {
    if (!isPlainObject(value)) return null;
    const version = value['appSpecVersion'];
    return typeof version === 'number' && Number.isFinite(version) ? version : null;
}

/** The `kind` a block declares, when it declares a string one. */
function kindOf(value: unknown): string | null {
    if (!isPlainObject(value)) return null;
    const kind = value['kind'];
    return typeof kind === 'string' && kind.length > 0 ? kind : null;
}

/**
 * Collapse the structural list: one issue per (pointer, code), and never an
 * `unknown_field` on a pointer that already carries a structural report.
 *
 * The second half applies §22:511-513 *inside* the structural layer: a mapping
 * that declares the same key twice reports `duplicate_key`, and the collapsed
 * value must not then be reported as `unknown_field` as well.
 */
function dedupeStructural(structural: readonly StructuralFinding[]): StructuralFinding[] {
    const seen = new Set<string>();
    const result: StructuralFinding[] = [];
    for (const item of structural) {
        const identity = `${item.pointer}\u0000${item.code}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (item.code === 'unknown_field' || item.code === 'unknown_field_newer_version') {
            if (result.some((other) => other.pointer === item.pointer)) continue;
        }
        result.push(item);
    }
    return result;
}

/**
 * The pipeline both entry points run, from a spec block onwards.
 *
 * Never throws, and never lets a late stage turn into an exception: the repair
 * loop, the rule engine and the issue builders are each guarded (FR-8).
 */
function runPipeline(
    input: PipelineInput,
    options: AppSpecValidationOptions,
): AppSpecValidationResult {
    const mode = normaliseMode(options.mode);
    const context: RuleContext = { ...(options.context ?? {}), mode };
    const lookup = input.lookup;

    // ── a fatal problem suppresses the rule set ────────────────────────────
    if (input.fatal !== null) {
        const fatal: AppSpecRuleFinding = {
            ...input.fatal,
            path: pointerToPath(input.fatal.pointer),
            displayPath:
                input.fatal.pointer === DOCUMENT_POINTER
                    ? 'works.yml'
                    : displayPathFor(null as unknown as AppSpec, input.fatal.pointer),
            // §22:513 — the issue that names it records which rules were skipped.
            params: { ...(input.fatal.params ?? {}), skippedRules: 'all' },
        };
        return assemble([fatal], null, lookup, false, APP_SPEC_ALL_RULE_LABELS);
    }

    // ── the structural layer ───────────────────────────────────────────────
    const blockAbsent = !isPlainObject(input.specBlock);
    const stripped = blockAbsent ? {} : stripExtensionKeys(input.specBlock);
    const mapping: StructuralMapping = {
        newerVersion: (() => {
            const declared = versionOf(stripped);
            return declared !== null && declared > APP_SPEC_SUPPORTED_VERSION ? declared : null;
        })(),
        declaredKind: kindOf(stripped),
        rootKind: input.rootKind,
    };

    const structural: StructuralFinding[] = [
        ...(input.envelope === null || input.envelope === undefined ? [] : [input.envelope]),
        ...input.leading,
    ];
    const parsed = appSpecSchema.safeParse(stripped);
    if (!parsed.success) {
        for (const issue of parsed.error.issues) {
            if (issue.code === 'unrecognized_keys') {
                const parent = issue.path as readonly (string | number)[];
                for (const key of issue.keys) {
                    structural.push(unknownFieldFor(key, parent, mapping));
                }
                continue;
            }
            const mapped = structuralFindingFor(issue, mapping);
            if (mapped !== null) structural.push(mapped);
        }
    }

    // §4:99 — `source` is required in `data-repository` mode, and therefore for
    // draft text too (§3:88). Blueprint mode explicitly allows a file without it,
    // and a document with no block at all is already reported by `envelope`.
    if (
        !blockAbsent &&
        mode !== 'blueprint' &&
        !Object.prototype.hasOwnProperty.call(stripped as Record<string, unknown>, 'source')
    ) {
        structural.push({
            code: 'required',
            severity: 'error',
            pointer: pointerOf(['source']),
            params: { key: 'source' },
        });
    }

    // §1:64 — the two spellings of `kind` must agree. The schema's
    // `literal('app')` already rejects a wrong `spec.kind`; this covers the
    // reverse (a root kind that differs while `spec.kind` holds the literal).
    if (
        mapping.declaredKind !== null &&
        input.rootKind !== null &&
        mapping.declaredKind !== input.rootKind
    ) {
        structural.push({
            code: 'kind_mismatch',
            severity: 'error',
            pointer: pointerOf(['kind']),
            params: { root: input.rootKind, declared: mapping.declaredKind },
        });
    }

    const deduped = dedupeStructural(structural);
    const structuralPointers = new Set(deduped.map((item) => item.pointer));

    // ── the rules, over a repaired copy (§22:509-513, FR-83) ───────────────
    const repaired = repairForRules(stripped);
    let spec = repaired.spec;
    let suppressedRules: readonly string[] = [];
    const ruleFindings: AppSpecRuleFinding[] = [];

    if (spec === null) {
        // The block could not be turned into a parse: the rules cannot run, and
        // §22:513 wants the issue that names it to say so.
        if (deduped.length > 0) {
            deduped[0] = {
                ...deduped[0],
                params: { ...(deduped[0].params ?? {}), skippedRules: 'all' },
            };
        }
        suppressedRules = APP_SPEC_ALL_RULE_LABELS;
    } else {
        const deferred = repaired.pruned.filter((pointer) => isDeferredPointer(pointer));
        if (deferred.length > 0) spec = restoreDeferred(spec, stripped, deferred);
        // The deferred pointers were pruned only to reach a parse and their values
        // are back: the rule that owns them (T5's `cron_invalid`) must be able to
        // report, so they are not part of the suppression set.
        const prunedForRules = new Set(
            repaired.pruned.filter((pointer) => !isDeferredPointer(pointer)),
        );
        const run = runRules(spec, context, prunedForRules);
        // A rule finding and a structural finding on the same leaf is the
        // duplicate §22:511-513 forbids; the structural one wins, because it
        // carries the reason the leaf could not be read.
        ruleFindings.push(...run.findings.filter((item) => !structuralPointers.has(item.pointer)));
        suppressedRules = run.suppressedRules;
    }

    const displaySpec = isPlainObject(stripped) ? (stripped as unknown as AppSpec) : null;
    const findings: AppSpecRuleFinding[] = [
        ...deduped.map((item) => ({
            code: item.code,
            severity: item.severity,
            pointer: item.pointer,
            path: pointerToPath(item.pointer),
            displayPath:
                displaySpec === null
                    ? pointerToPath(item.pointer)
                    : displayPathFor(displaySpec, item.pointer),
            ...positionFor(item.pointer, lookup),
            ...(item.params === undefined ? {} : { params: item.params }),
        })),
        ...ruleFindings,
    ];

    return assemble(findings, spec, lookup, true, suppressedRules);
}

/** The finding-shaped position of a pointer, when the caller had a file to point into. */
function positionFor(
    pointer: string,
    lookup: AppSpecRulePositionLookup | null,
): { readonly line?: number; readonly column?: number } {
    if (lookup === null) return {};
    const resolved =
        pointer === DOCUMENT_POINTER
            ? ROOT_POSITION
            : (nearestPosition(pointer, lookup) ?? ROOT_POSITION);
    return { line: resolved.line, column: resolved.column };
}

// ---------------------------------------------------------------------------
// The two entry points
// ---------------------------------------------------------------------------

/**
 * Validate `.works/works.yml` **text** — the platform's own entry point
 * (plan §2.2:131-142).
 *
 * Never throws. A document that cannot be parsed is reported as `yaml_syntax`
 * (or `file_too_large` / `yaml_alias_limit`), never raised, and the rule set runs
 * whenever it *can* be parsed (§22:507-513, FR-83).
 *
 * The whole document is measured — the 256 KiB size, the alias count and the
 * depth of §2.5 all describe the **file**, which is why the depth check runs on
 * the value `toJS()` returns, `x-` keys and all, before they are stripped
 * (plan §2.2:136-137).
 */
export function validateAppSpecDocument(
    text: unknown,
    options: AppSpecValidationOptions = {},
): AppSpecValidationResult {
    const rootKind = options.rootKind ?? null;

    // ── 256 KiB (§2.5:78, FR-7) ────────────────────────────────────────────
    if (typeof text !== 'string') {
        return runPipeline(
            {
                specBlock: null,
                lookup: null,
                rootKind,
                fatal: { code: 'yaml_syntax', severity: 'error', pointer: DOCUMENT_POINTER },
                leading: [],
            },
            options,
        );
    }

    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > APP_SPEC_FILE_MAX_BYTES) {
        return runPipeline(
            {
                specBlock: null,
                lookup: null,
                rootKind,
                fatal: {
                    code: 'file_too_large',
                    severity: 'error',
                    pointer: DOCUMENT_POINTER,
                    params: { bytes, maxBytes: APP_SPEC_FILE_MAX_BYTES },
                },
                leading: [],
            },
            options,
        );
    }

    // ── YAML (§2.5:78-79, §22:508) ─────────────────────────────────────────
    const counter = new LineCounter();
    let document: ReturnType<typeof parseDocument>;
    try {
        document = parseDocument(text, {
            uniqueKeys: true,
            lineCounter: counter,
        });
    } catch (error) {
        return runPipeline(
            {
                specBlock: null,
                lookup: null,
                rootKind,
                fatal: yamlSyntaxFinding(error),
                leading: [],
            },
            options,
        );
    }

    const lookup = lookupFor(buildPositions(document.contents, counter));

    const syntaxErrors = document.errors.filter((error) => error.code !== 'DUPLICATE_KEY');
    if (syntaxErrors.length > 0) {
        return runPipeline(
            {
                specBlock: null,
                lookup,
                rootKind,
                fatal: yamlSyntaxFinding(
                    syntaxErrors[0],
                    positionOfYamlError(syntaxErrors[0], counter),
                ),
                leading: [],
            },
            options,
        );
    }

    // `uniqueKeys: true` reports a duplicate mapping key here rather than as a
    // parse failure, and §2.5:79 gives it its own code. It does **not** suppress
    // the rule set — §22:508 names only four inputs that do.
    const leading: StructuralFinding[] = [];
    for (const error of document.errors) {
        if (error.code !== 'DUPLICATE_KEY') continue;
        const pointer = pointerAtOffset(document.contents, error.pos[0]);
        leading.push({
            code: 'duplicate_key',
            severity: 'error',
            pointer,
            params: { key: pointerKeyOf(pointer) },
        });
    }

    // ── toJS: alias expansion (§2.5:78) ────────────────────────────────────
    let raw: unknown;
    try {
        // `maxAliasCount` is a **`toJS`** option, not a `parseDocument` one
        // (`yaml` v2 applies it while expanding): the limit of §2.5:78 is
        // `APP_SPEC_YAML_MAX_ALIASES`, and the library counts the anchor's own
        // materialisation as one expansion — so a document with 99 alias nodes
        // is 100 expansions and accepted, and one with 101 is refused.
        raw = document.toJS({ maxAliasCount: APP_SPEC_YAML_MAX_ALIASES });
    } catch (error) {
        if (isAliasExpansionError(error)) {
            const pointer = firstAliasPointer(document.contents) ?? DOCUMENT_POINTER;
            return runPipeline(
                {
                    specBlock: null,
                    lookup,
                    rootKind,
                    fatal: {
                        code: 'yaml_alias_limit',
                        severity: 'error',
                        pointer,
                        params: { max: APP_SPEC_YAML_MAX_ALIASES },
                    },
                    leading: [],
                },
                options,
            );
        }
        return runPipeline(
            { specBlock: null, lookup, rootKind, fatal: yamlSyntaxFinding(error), leading: [] },
            options,
        );
    }

    // ── depth (§2.5:78, FR-7) ──────────────────────────────────────────────
    const deepest = deepestDepth(raw);
    if (deepest.depth > APP_SPEC_MAX_DEPTH) {
        return runPipeline(
            {
                specBlock: null,
                lookup,
                rootKind,
                fatal: {
                    code: 'out_of_range',
                    severity: 'error',
                    pointer: deepest.pointer,
                    params: { limit: APP_SPEC_MAX_DEPTH, depth: deepest.depth },
                },
                leading: [],
            },
            options,
        );
    }

    // ── the envelope, then the spec block (§1:61-65) ───────────────────────
    // These are **not** among §22:508's four fatal inputs: the document parsed,
    // so the rule set still runs — over an empty block, which reports nothing —
    // and the envelope problem is published as an ordinary structural issue.
    if (!isPlainObject(raw)) {
        return runPipeline(
            {
                specBlock: null,
                lookup,
                rootKind,
                fatal: null,
                envelope: {
                    code: 'invalid_type',
                    severity: 'error',
                    pointer: DOCUMENT_POINTER,
                    params: { expected: 'object' },
                },
                leading,
            },
            options,
        );
    }

    if (!Object.prototype.hasOwnProperty.call(raw, 'spec')) {
        return runPipeline(
            {
                specBlock: null,
                lookup,
                rootKind,
                fatal: null,
                envelope: {
                    code: 'required',
                    severity: 'error',
                    pointer: pointerOf(['spec']),
                    params: { key: 'spec' },
                },
                leading,
            },
            options,
        );
    }

    if (!isPlainObject(raw['spec'])) {
        return runPipeline(
            {
                specBlock: null,
                lookup,
                rootKind,
                fatal: null,
                envelope: {
                    code: 'invalid_type',
                    severity: 'error',
                    pointer: pointerOf(['spec']),
                    params: { key: 'spec', expected: 'object' },
                },
                leading,
            },
            options,
        );
    }

    return runPipeline(
        {
            specBlock: raw['spec'],
            lookup,
            rootKind: kindOf(raw) ?? rootKind,
            fatal: null,
            leading,
        },
        options,
    );
}

/**
 * Validate an **already-parsed** App spec — the same pipeline without positions
 * (plan §2.2:144).
 *
 * `obj` is accepted in either shape a caller can hold:
 *
 * - the whole document (`{ version, kind, spec }`) — detected by an own `spec`
 *   that is a plain object, so `validateWorksConfig` (T7) can hand over what it
 *   already parsed and get the same result the text entry point gives;
 * - the `spec` block alone — everything else, which is what a spec-block caller
 *   (a Blueprint apply, an editor plugin) holds.
 *
 * Either way the issues carry no `line`/`column`: there is no file to point into,
 * and a consumer renders the `displayPath` without a link. The depth limit of
 * §2.5 still applies, measured on what was handed over.
 */
export function validateAppSpecObject(
    obj: unknown,
    options: AppSpecValidationOptions = {},
): AppSpecValidationResult {
    const asDocument =
        isPlainObject(obj) &&
        Object.prototype.hasOwnProperty.call(obj, 'spec') &&
        isPlainObject(obj['spec']);
    const specBlock = asDocument ? (obj as Record<string, unknown>)['spec'] : obj;

    const deepest = deepestDepth(specBlock);
    if (deepest.depth > APP_SPEC_MAX_DEPTH) {
        return runPipeline(
            {
                specBlock: null,
                lookup: null,
                rootKind: options.rootKind ?? null,
                fatal: {
                    code: 'out_of_range',
                    severity: 'error',
                    pointer: deepest.pointer,
                    params: { limit: APP_SPEC_MAX_DEPTH, depth: deepest.depth },
                },
                leading: [],
            },
            options,
        );
    }

    // `kindOf` reads `value['kind']`, so it takes the OBJECT: handing it
    // `obj['kind']` (the string) made it answer `null` for every document, and
    // `rootKind` fell through to `options.rootKind` — which a document-form
    // caller does not pass — so `kind_mismatch` carried no `root` and a
    // document that disagreed with itself was reported as a bare
    // `invalid_value`. `validateAppSpecText` always passed the object
    // (`:1986`), so the two entry points disagreed about the same document.
    const rootKind = asDocument
        ? (kindOf(obj) ?? options.rootKind ?? null)
        : (options.rootKind ?? null);

    return runPipeline({ specBlock, lookup: null, rootKind, fatal: null, leading: [] }, options);
}

// ---------------------------------------------------------------------------
// Helpers the document path needs
// ---------------------------------------------------------------------------

/** The deepest nesting and the pointer that reaches it (§2.5:78). */
function deepestDepth(value: unknown): { readonly depth: number; readonly pointer: string } {
    let depth = 0;
    let pointer = DOCUMENT_POINTER;

    const walk = (node: unknown, path: string, level: number): void => {
        if (Array.isArray(node)) {
            if (level > depth) {
                depth = level;
                pointer = path;
            }
            node.forEach((item, index) => walk(item, `${path}/${index}`, level + 1));
            return;
        }
        if (!isPlainObject(node)) return; // a scalar adds no nesting
        if (level > depth) {
            depth = level;
            pointer = path;
        }
        for (const [key, item] of Object.entries(node)) walk(item, `${path}/${key}`, level + 1);
    };

    walk(value, DOCUMENT_POINTER, 1);
    return { depth, pointer };
}

/** Did `toJS()` refuse the document for expanding too many aliases? */
function isAliasExpansionError(error: unknown): boolean {
    return error instanceof Error && /alias count/i.test(error.message);
}

/** The `yaml_syntax` finding for a thrown or collected YAML error. */
function yamlSyntaxFinding(
    error: unknown,
    position?: AppSpecRulePosition | null,
): StructuralFinding {
    const code = (error as { code?: unknown } | null)?.code;
    return {
        code: 'yaml_syntax',
        severity: 'error',
        pointer: DOCUMENT_POINTER,
        params: {
            ...(position === null || position === undefined
                ? {}
                : { line: position.line, column: position.column }),
            ...(typeof code === 'string' ? { reason: code } : {}),
        },
    };
}

/** The position a YAML error carries, when it carries one. */
function positionOfYamlError(error: unknown, counter: LineCounter): AppSpecRulePosition | null {
    const pos = (error as { pos?: readonly number[] } | null)?.pos;
    if (!Array.isArray(pos) || typeof pos[0] !== 'number') return null;
    try {
        const position = counter.linePos(pos[0]);
        return { line: position.line, column: position.col };
    } catch {
        return null;
    }
}

/**
 * The pointer of the mapping key that starts at `offset`, or the document root.
 *
 * A YAML error reports a byte offset, not a key, and §23 wants a pointer — so the
 * key list just walked is searched for the one whose range begins exactly there.
 * `duplicate_key` is the code that needs it (the parser reports only "Map keys
 * must be unique"), and the fallback is the root rather than a guess.
 */
function pointerAtOffset(document: unknown, offset: number): string {
    let found: string | null = null;

    const walk = (node: unknown, pointer: string): void => {
        if (found !== null) return;
        if (isMap(node)) {
            for (const item of node.items) {
                if (found !== null) return;
                const key = isScalar(item.key) ? String(item.key.value) : '';
                const range = isScalar(item.key) ? item.key.range : undefined;
                if (range !== undefined && range !== null && range[0] === offset) {
                    found = `${pointer}/${key}`;
                    return;
                }
                walk(item.value, `${pointer}/${key}`);
            }
            return;
        }
        if (isSeq(node)) {
            node.items.forEach((item, index) => walk(item, `${pointer}/${index}`));
        }
    };

    walk(document, '');
    return found ?? DOCUMENT_POINTER;
}

/** The last segment of a pointer — the key a message can name. */
function pointerKeyOf(pointer: string): string {
    const segments = pointer.split('/').filter((segment) => segment.length > 0);
    return segments.length === 0 ? '' : segments[segments.length - 1];
}

/**
 * The first YAML alias in a document, as a pointer, or `null`.
 *
 * `toJS()` refuses an over-expanded document with a bare `ReferenceError` —
 * message, no position — so the alias-limit report finds its own line by walking
 * the parsed document for the first `*anchor` (§23:533's nearest-position rule
 * cannot help: the error names no pointer at all).
 */
export function firstAliasPointer(document: unknown): string | null {
    let found: string | null = null;
    const walk = (node: unknown, pointer: string): void => {
        if (found !== null) return;
        if (isAlias(node)) {
            found = pointer.length === 0 ? DOCUMENT_POINTER : pointer;
            return;
        }
        if (isMap(node)) {
            for (const item of node.items) {
                walk(item.value, `${pointer}/${isScalar(item.key) ? String(item.key.value) : ''}`);
            }
            return;
        }
        if (isSeq(node)) node.items.forEach((item, index) => walk(item, `${pointer}/${index}`));
    };
    walk(document, '');
    return found;
}
