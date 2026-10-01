/**
 * App Works — the App spec **issue model**: the append-only code catalogue, the
 * severity, the validation status and the limits the validator reports with.
 *
 * Owning epic: **APW-03** (App spec, Apps catalog and license gate).
 *
 * Spec: `docs/specs/features/app-works/APW-03-app-spec-and-catalog/schema.md`
 * is the App spec's authority — §2.5 (limits), §3 (the modes), §22 (the
 * cross-field rules) and §23 (the issue object and the code list). Plan:
 * `.../APW-03-app-spec-and-catalog/plan.md` §3.2 (the shared types) and §2.2
 * (the validator pipeline). Bindings: `docs/specs/features/app-works/CONTRACTS.md`
 * §2A (the shared-type table) and **R-26**, the owner's additive-only rule.
 *
 * **The code list is append-only (schema.md §23:536 — "Codes are append-only.
 * Removing or renaming a code is a breaking change (Constitution X)").** A new
 * code is appended; an existing code is never renamed, never re-spelled and
 * never removed. `apps-contracts.spec.ts` pins the whole tuple as a snapshot on
 * purpose: adding a code must be a deliberate edit of two files, and removing
 * one must fail.
 *
 * Two spellings in here are the specs' own and are NOT typos to be corrected:
 * `sourceOfferMissing` (schema.md:481 — the one camelCase code, kept because
 * ACC-03-36 and the refusal copy name it that way) and `unknown_field_newer_version`
 * (schema.md §23:540).
 *
 * Where the numeric limits live: plan §3.2 lists every constant in one code
 * block and names `apps-limits.ts` as their home. That file already shipped with
 * APW-01's repository-stage and quota limits (`apps-limits.ts:39-103`, `:174-181`)
 * and this task must not edit a landed module, so the App-spec limits live with
 * the codes they produce here, and the catalog/license limits live in
 * `apps-catalog.types.ts` / `app-license.types.ts`. No limit is declared twice.
 */

// ---------------------------------------------------------------------------
// Limits the validator reports with (schema.md §2.5:78-80, plan §3.2:474-478)
// ---------------------------------------------------------------------------

/**
 * The largest `.works/works.yml` the platform reads, in bytes — 256 KiB
 * (schema.md §2.5:78 "File ≤ 256 KiB (error `file_too_large`)"; plan.md:474;
 * FR-7). A larger file is `file_too_large`, which is one of the four problems
 * that suppress the rule set entirely (schema.md:508).
 */
export const APP_SPEC_FILE_MAX_BYTES = 262_144;

/**
 * How many issues one evaluation reports before `truncated: true` — 200
 * (schema.md §2.5:79; plan.md:475; FR-17's `issuesTruncated`, plan §3.1:416).
 */
export const APP_SPEC_MAX_ISSUES = 200;

/**
 * How many YAML alias expansions a document may use — 100
 * (schema.md §2.5:78 "YAML alias expansions ≤ 100 (error `yaml_alias_limit`)";
 * plan.md:476; FR-7).
 */
export const APP_SPEC_YAML_MAX_ALIASES = 100;

/**
 * The deepest nesting the validator accepts — 12 (schema.md §2.5:78; plan.md:477;
 * FR-7). The depth failure, like `yaml_alias_limit`, suppresses the rule set
 * (schema.md:508).
 */
export const APP_SPEC_MAX_DEPTH = 12;

/**
 * The Damerau–Levenshtein distance within which `unknown_field` suggests a
 * defined key — 2 (schema.md §2:70 "within edit distance 2 (`replica` →
 * `replicas`)"; plan.md:478 and §2.2:150). Ties resolve alphabetically.
 */
export const APP_SPEC_SUGGESTION_MAX_DISTANCE = 2;

// ---------------------------------------------------------------------------
// Severity, status and mode (schema.md §3:84-89, §22, §23; plan §3.1:413)
// ---------------------------------------------------------------------------

/**
 * The two severities an issue may carry (schema.md §22's Severity column,
 * §23:520; FR-5). A warning is shown and the spec still applies; an error keeps
 * the previous effective spec (schema.md:91-93, FR-20).
 */
export const APP_SPEC_SEVERITIES = ['error', 'warning'] as const;

/** Union derived from {@link APP_SPEC_SEVERITIES}. */
export type AppSpecSeverity = (typeof APP_SPEC_SEVERITIES)[number];

/**
 * The five results one evaluation can have, spelled exactly as the
 * `validationStatus` column stores them (plan §3.1:413): `valid`,
 * `valid_with_warnings`, `invalid`, `missing` (no `.works/works.yml` on the
 * tracked branch) and `unreadable` (a provider failure kept apart from a real
 * verdict, plan §9.2:826).
 */
export const APP_SPEC_VALIDATION_STATUSES = [
	'valid',
	'valid_with_warnings',
	'invalid',
	'missing',
	'unreadable'
] as const;

/** Union derived from {@link APP_SPEC_VALIDATION_STATUSES}. */
export type AppSpecValidationStatus = (typeof APP_SPEC_VALIDATION_STATUSES)[number];

/**
 * Where validation runs (schema.md §3:84-89; T1, tasks.md:62-63).
 *
 * `data-repository` is the platform's mode for a Work's Work Repository and for
 * draft text; `blueprint` is the Apps catalog CI's mode, where `source` and
 * `blueprint` are allowed and expected after the 2026-09-17 correction to §3:89;
 * `draft` is the T1 name for text a member is still editing, which the `validate`
 * route also runs in `data-repository` mode unless a Work id is given
 * (schema.md:88).
 *
 * `blueprint-draft` is **not** a fourth member: tasks.md:189 and tasks.md:606 use
 * that name in prose, but schema.md §3's table has two platform modes and
 * ACC-03-52 is satisfied by `blueprint` mode once §3 allows `source` and
 * `blueprint` there. Adding a member here would invent a mode no spec defines.
 */
export const APP_SPEC_VALIDATION_MODES = ['draft', 'data-repository', 'blueprint'] as const;

/** Union derived from {@link APP_SPEC_VALIDATION_MODES}. */
export type AppSpecValidationMode = (typeof APP_SPEC_VALIDATION_MODES)[number];

// ---------------------------------------------------------------------------
// One issue (schema.md §23:517-536; FR-5, FR-6)
// ---------------------------------------------------------------------------

/**
 * One problem the validator reports, in schema.md §23's exact shape.
 *
 * `path` uses array indexes, `displayPath` uses component/job/env **names**
 * where they exist (§23:532), `pointer` is the JSON pointer the positions were
 * looked up by, and `line`/`column` are 1-based and point at the key when it is
 * present, else at the nearest parent key (§23:533). Both are **absent** when
 * the caller validated an already-parsed object, which has no YAML positions
 * (plan §2.2:144) — a consumer renders the path without a link in that case.
 *
 * `message` and `hint` are English and never contain a value from the file for
 * `secret` entries, `build.args` or `prompt.example` (§23:534; FR-6), and
 * `params` is why the builder's parameter type admits names only
 * (plan §2.2:153-155).
 */
export interface AppSpecIssue {
	/** One member of {@link APP_SPEC_ISSUE_CODES}. */
	code: AppSpecIssueCode;
	severity: AppSpecSeverity;
	/** `spec.components[0].port`. */
	path: string;
	/** `/spec/components/0/port`. */
	pointer: string;
	/** `components › web › port`. */
	displayPath: string;
	/** 1-based; absent when the caller had no YAML positions (plan.md:144). */
	line?: number;
	/** 1-based; absent together with {@link AppSpecIssue.line}. */
	column?: number;
	message: string;
	hint?: string;
	/** Names and scalar facts only — never a value of a secret entry (FR-6). */
	params?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Every code the App spec validator may report — the structural codes of
 * schema.md §23:538-543 first (in the order that list writes them), then the
 * rule codes of §22 in rule order R1→R27, then the five server-only codes of
 * §22:483-488.
 *
 * This includes `keypair_format_unsupported` (R25, schema.md:479) and
 * `keypair_password_invalid` (R26, schema.md:480) — the two the `env[].generate.keypair`
 * work of R-11 reports — and `sourceOfferMissing` (R27, schema.md:481) even
 * though it is spelled in camelCase there. `blueprint_mode_forbidden_key` stays
 * in the list although §3 no longer emits it for `spec.source`/`spec.blueprint`:
 * §23:541 keeps it "for the structural cases §2 describes" and a code is never
 * removed (Constitution X).
 */
export const APP_SPEC_ISSUE_CODES = [
	// Structural (schema.md §23:538-543)
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
	// Rule codes (schema.md §22:455-481, R1 → R27)
	'web_component_needs_port',
	'strategy_requires_components',
	'components_require_strategy',
	'primary_component_invalid',
	'duplicate_name',
	'reference_unresolved',
	'secret_reference_not_secret',
	'phase_mismatch',
	'env_source_count',
	'literal_secret_value',
	'generate_validate_conflict',
	'literal_secret_in_build_args',
	'secret_build_arg',
	'upstream_pr_approval_required',
	'upstream_forbidden_for_link',
	'upstream_sync_requires_upstream',
	'upstream_prs_require_fork',
	'component_ref_unknown',
	'auth_env_not_secret',
	'limit_below_request',
	'volume_replicas',
	'image_not_pinned',
	'advisory_check',
	'schedule_too_frequent',
	'path_outside_repository',
	'reserved_env_name',
	'license_declared_mismatch',
	'keypair_format_unsupported',
	'keypair_password_invalid',
	'sourceOfferMissing',
	// Server-only rules (schema.md §22:483-488)
	'source_relation_mismatch',
	'blueprint_unknown',
	'build_strategy_unavailable',
	'dependency_unavailable',
	'tracked_branch_missing'
] as const;

/** Union derived from {@link APP_SPEC_ISSUE_CODES}. */
export type AppSpecIssueCode = (typeof APP_SPEC_ISSUE_CODES)[number];
