import { describe, expect, it } from 'vitest';

// The package root on purpose: one export below is imported from `../../index.js`
// as well, so a module appended to `apps/index.ts` without reaching
// `src/index.ts` (or an ambiguous name that silently vanishes from the root
// namespace) fails here as well as in `src/__tests__/index.barrel.spec.ts`.
import {
	APP_SPEC_ISSUE_CODES as APP_SPEC_ISSUE_CODES_FROM_ROOT,
	APP_SPEC_VALIDATION_MODES as APP_SPEC_VALIDATION_MODES_FROM_ROOT,
	isSourceOnlyAppSpec as isSourceOnlyAppSpecFromRoot
} from '../../index.js';

import {
	APPS_MANAGED_REQUIRES_VERIFIED,
	BLUEPRINT_MATCH_SOURCES,
	LICENSE_ATTEST_PER_MIN,
	LICENSE_CLASSES,
	LICENSE_CLASS_RANK,
	LICENSE_EVIDENCE_MAX,
	LICENSE_HEADER_SCAN_BYTES,
	LICENSE_MAX_FILE_READS,
	LICENSE_MIXED_DIR_NAMES,
	LICENSE_MIXED_MAX_DEPTH,
	LICENSE_REGISTRY_SOURCES,
	LICENSE_SOURCES,
	LICENSE_TEXT_MATCH_THRESHOLD,
	LICENSE_TREE_MAX_ENTRIES,
	MANAGED_HOSTING_AVAILABILITIES,
	MANAGED_HOSTING_REASONS
} from '../app-license.types.js';

import {
	APP_SPEC_FILE_MAX_BYTES,
	APP_SPEC_ISSUE_CODES,
	APP_SPEC_MAX_DEPTH,
	APP_SPEC_MAX_ISSUES,
	APP_SPEC_SEVERITIES,
	APP_SPEC_SUGGESTION_MAX_DISTANCE,
	APP_SPEC_VALIDATION_MODES,
	APP_SPEC_VALIDATION_STATUSES,
	APP_SPEC_YAML_MAX_ALIASES,
	type AppSpecIssue
} from '../app-spec-issues.js';

import {
	APP_SPEC_BLOCK_DEFAULTS,
	APP_SPEC_BUILD_STRATEGIES,
	APP_SPEC_COMPONENT_ROLES,
	APP_SPEC_CRON_CONCURRENCIES,
	APP_SPEC_DOMAIN_CHANGES,
	APP_SPEC_DRAFT_VALIDATE_PER_MIN,
	APP_SPEC_ENV_PHASES,
	APP_SPEC_EVALUATE_COALESCE_MS,
	APP_SPEC_EVALUATION_TRIGGERS,
	APP_SPEC_GENERATE_ALPHABETS,
	APP_SPEC_GENERATE_KINDS,
	APP_SPEC_GENERATE_ROTATIONS,
	APP_SPEC_HTTP_AUTH_SCHEMES,
	APP_SPEC_HTTP_METHODS,
	APP_SPEC_JOB_WHENS,
	APP_SPEC_KEYPAIR_FORMATS,
	APP_SPEC_KEYPAIR_TYPES,
	APP_SPEC_LAZY_HEAD_CHECK_MS,
	APP_SPEC_MAX_PROTECTED_PATHS,
	APP_SPEC_MAX_REQUIRE_HUMAN_MERGE_PATHS,
	APP_SPEC_POSTGRES_VERSIONS,
	APP_SPEC_PROBE_KINDS,
	APP_SPEC_PUBLIC_KEY_SUFFIX,
	APP_SPEC_REDIS_MAXMEMORY_POLICIES,
	APP_SPEC_REDIS_VERSIONS,
	APP_SPEC_REFRESH_PER_MIN,
	APP_SPEC_SMOKE_HTTP_METHODS,
	APP_SPEC_SMOKE_WHENS,
	APP_SPEC_SOURCE_ONLY_KEYS,
	APP_SPEC_SOURCE_RELATIONS,
	APP_SPEC_UPSTREAM_SYNC_MODES,
	APP_SPEC_VERSION,
	isSourceOnlyAppSpec,
	type AppSpec
} from '../app-spec.types.js';

import {
	APPS_CATALOG_CACHE_TTL_MS,
	APPS_CATALOG_CATEGORIES,
	APPS_CATALOG_ENTRY_LICENSE_CLASSES,
	APPS_CATALOG_ENTRY_STATUSES,
	APPS_CATALOG_FAILURE_TTL_MS,
	APPS_CATALOG_FANOUT_PER_RUN,
	APPS_CATALOG_FETCH_TIMEOUT_MS,
	APPS_CATALOG_LAST_GOOD_REGISTRY_MS,
	APPS_CATALOG_MANIFEST_MAX_BYTES,
	APPS_CATALOG_MAX_ENTRIES,
	APPS_CATALOG_PAGE_SIZE,
	APPS_CATALOG_PAGE_SIZE_MAX,
	APPS_CATALOG_PUBLIC_PER_MIN,
	APPS_CATALOG_README_MAX_BYTES,
	APPS_CATALOG_REGISTRY_MAX_BYTES,
	APPS_CATALOG_REFRESH_CRON,
	APPS_CATALOG_SEARCH_MIN_CHARS,
	APPS_CATALOG_VERIFICATION_STATUSES,
	BLUEPRINT_ALTERNATIVES_MAX,
	BLUEPRINT_APPLY_PER_HOUR,
	BLUEPRINT_APPLY_RETRIES,
	BLUEPRINT_OVERLAY_FILE_MAX_BYTES,
	BLUEPRINT_OVERLAY_MAX_FILES,
	BLUEPRINT_OVERLAY_TOTAL_MAX_BYTES,
	BLUEPRINT_PROBE_MAX_READS,
	BLUEPRINT_RESOLUTION_REASONS,
	BLUEPRINT_RESOLVE_HIT_TTL_MS,
	BLUEPRINT_RESOLVE_MISS_TTL_MS,
	type AppsCatalogEntry,
	type AppsCatalogSpecSummary,
	type BlueprintResolution
} from '../apps-catalog.types.js';

import { APP_BLUEPRINT_APPLY_STATUSES, buildAppSpecLineLink, type WorkAppSpecStateDto } from '../work-app-spec.dto.js';

/**
 * The App Works contract surface of APW-03 (T1).
 *
 * These pins are deliberately literal. The App spec's codes are **append-only**
 * (schema.md §23:536) and its closed unions carry behaviour in their **order**
 * (the managed-hosting reasons are evaluated in order and only the first failing
 * one is reported, plan §2.4:216), so a reordering or a removal must be a
 * visible failure rather than a silent behaviour change. Every numeric constant
 * names the `plan.md:line` it comes from, and a spec test proves one of them
 * binds: perturbing a value or a union member fails this file.
 */
describe('App Works contract surface (APW-03 T1)', () => {
	describe('APP_SPEC_ISSUE_CODES — the append-only catalogue (schema.md §22–§23)', () => {
		it('is exactly the 61 codes of schema.md §23:538-543 and §22:455-488, in that order', () => {
			// A snapshot on purpose: appending a code is a two-file edit, and
			// removing one is a breaking change (schema.md:536, Constitution X).
			expect(APP_SPEC_ISSUE_CODES).toEqual([
				// Structural codes (schema.md §23:538-543)
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
			]);
		});

		it('reaches the package root unchanged', () => {
			expect(APP_SPEC_ISSUE_CODES_FROM_ROOT).toBe(APP_SPEC_ISSUE_CODES);
		});

		it('has no duplicate code', () => {
			expect(new Set(APP_SPEC_ISSUE_CODES).size).toBe(APP_SPEC_ISSUE_CODES.length);
		});

		it('carries the R-11 key pair codes and R27’s source-offer code', () => {
			// Named, not just counted: these three are the ones T1 calls out and the
			// ones an i18n leaf (`issues.<camelCode>`, plan §8:770) exists per code.
			expect(APP_SPEC_ISSUE_CODES).toContain('keypair_format_unsupported');
			expect(APP_SPEC_ISSUE_CODES).toContain('keypair_password_invalid');
			expect(APP_SPEC_ISSUE_CODES).toContain('sourceOfferMissing');
		});

		it('spells every code snake_case except the one the spec spells camelCase', () => {
			const nonSnakeCase = APP_SPEC_ISSUE_CODES.filter((code) => !/^[a-z][a-z0-9_]*$/.test(code));

			// `sourceOfferMissing` is schema.md:481's own spelling, confirmed by
			// ACC-03-36 and the refusal copy — correcting it here would break the
			// code (schema.md:536) and the message lookup that goes with it.
			expect(nonSnakeCase).toEqual(['sourceOfferMissing']);
		});

		it('orders the severities and the validation statuses as their columns read', () => {
			// schema.md §22's Severity column / plan §3.1:413.
			expect(APP_SPEC_SEVERITIES).toEqual(['error', 'warning']);
			expect(APP_SPEC_VALIDATION_STATUSES).toEqual([
				'valid',
				'valid_with_warnings',
				'invalid',
				'missing',
				'unreadable'
			]);
		});
	});

	describe('closed unions — members and order', () => {
		it('pins ManagedHostingReason in evaluation order (plan.md:216, :467; R-3)', () => {
			// Order IS behaviour: only the first failing reason is reported.
			expect(MANAGED_HOSTING_REASONS).toEqual([
				'licenseNotGreen',
				'upstreamAgreementMissing',
				'entryDisallows',
				'blueprintNotVerified',
				'managedTierDisabled'
			]);
		});

		it('derives the catalog’s availability from the same reasons (FR-35, plan.md:216)', () => {
			expect(MANAGED_HOSTING_AVAILABILITIES).toEqual([
				'available',
				'licenseNotGreen',
				'upstreamAgreementMissing',
				'entryDisallows',
				'blueprintNotVerified',
				'managedTierDisabled'
			]);
		});

		it('pins BlueprintMatchSource with explicit, as the superset (plan.md:425, CONTRACTS.md:321)', () => {
			// The canonical union; APW-01's `AppSourceBlueprintMatchSource`
			// (app-source.ts:282) is the source record's five-member spelling.
			expect(BLUEPRINT_MATCH_SOURCES).toEqual(['manifest', 'alias', 'fork', 'probe', 'explicit', 'file']);
			expect(BLUEPRINT_MATCH_SOURCES).toContain('explicit');
		});

		it('pins AppSpecBuildStrategy to R-13’s four values (tasks.md:61, CONTRACTS.md:56)', () => {
			expect(APP_SPEC_BUILD_STRATEGIES).toEqual(['dockerfile', 'image', 'auto', 'none']);
			expect(APP_SPEC_BUILD_STRATEGIES).toContain('auto');
		});

		it('pins AppSpecKeypairFormat to R-11’s three values (tasks.md:61, schema.md:273)', () => {
			expect(APP_SPEC_KEYPAIR_FORMATS).toEqual(['pem', 'base64url-raw', 'pkcs12']);
		});

		it('pins the AppSpecValidationMode tuple (tasks.md:62, schema.md §3:84-89)', () => {
			expect(APP_SPEC_VALIDATION_MODES).toEqual(['draft', 'data-repository', 'blueprint']);
			expect(APP_SPEC_VALIDATION_MODES_FROM_ROOT).toBe(APP_SPEC_VALIDATION_MODES);
		});

		it('pins the licence classes and the fixed class rank (plan.md:434, catalog.md:265)', () => {
			expect(LICENSE_CLASSES).toEqual(['green', 'amber', 'red', 'unknown']);
			expect(LICENSE_CLASS_RANK).toEqual({ green: 0, amber: 1, unknown: 2, red: 3 });
			expect(LICENSE_SOURCES).toEqual(['detected', 'blueprint', 'user']);
			expect(LICENSE_REGISTRY_SOURCES).toEqual(['live', 'last_good', 'snapshot']);
		});

		it('pins the Blueprint resolution reasons (plan.md:228, :237-238)', () => {
			expect(BLUEPRINT_RESOLUTION_REASONS).toEqual([
				'notListed',
				'lookupFailed',
				'refMismatch',
				'blueprintNotFound'
			]);
		});

		it('pins the fifteen catalog categories and the two declarable classes (catalog.md:89, :92, :105)', () => {
			expect(APPS_CATALOG_CATEGORIES).toHaveLength(15);
			expect(APPS_CATALOG_CATEGORIES).toContain('scheduling');
			expect(APPS_CATALOG_CATEGORIES).toContain('other');
			expect(APPS_CATALOG_ENTRY_STATUSES).toEqual(['production', 'beta', 'placeholder']);
			expect(APPS_CATALOG_VERIFICATION_STATUSES).toEqual(['candidate', 'verified', 'at-risk', 'not-verified']);
			// A red row is dropped before it is listed (plan.md:213, R-3), so `red`
			// is deliberately not a declarable entry class.
			expect(APPS_CATALOG_ENTRY_LICENSE_CLASSES).toEqual(['green', 'amber']);
		});

		it('pins the App spec’s remaining closed vocabularies (schema.md §5–§20)', () => {
			expect(APP_SPEC_SOURCE_RELATIONS).toEqual(['fork', 'private-copy', 'link']);
			expect(APP_SPEC_COMPONENT_ROLES).toEqual(['web', 'worker']);
			expect(APP_SPEC_PROBE_KINDS).toEqual(['startup', 'readiness', 'liveness']);
			expect(APP_SPEC_ENV_PHASES).toEqual(['runtime', 'build', 'both']);
			expect(APP_SPEC_GENERATE_KINDS).toEqual(['base64', 'hex', 'chars', 'uuid', 'keypair']);
			expect(APP_SPEC_GENERATE_ALPHABETS).toEqual(['alnum', 'alnum-symbols', 'hex-lower', 'base64url']);
			expect(APP_SPEC_GENERATE_ROTATIONS).toEqual(['never']);
			expect(APP_SPEC_KEYPAIR_TYPES).toEqual(['ed25519', 'ec-p256', 'rsa-2048', 'rsa-4096']);
			expect(APP_SPEC_JOB_WHENS).toEqual(['pre-deploy', 'first-deploy', 'post-deploy']);
			expect(APP_SPEC_HTTP_METHODS).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
			expect(APP_SPEC_HTTP_AUTH_SCHEMES).toEqual(['bearer', 'raw']);
			expect(APP_SPEC_CRON_CONCURRENCIES).toEqual(['forbid', 'allow']);
			expect(APP_SPEC_DOMAIN_CHANGES).toEqual(['restart', 'rebuild']);
			expect(APP_SPEC_SMOKE_HTTP_METHODS).toEqual(['GET', 'HEAD', 'POST']);
			expect(APP_SPEC_SMOKE_WHENS).toEqual(['always', 'first-deploy']);
			expect(APP_SPEC_UPSTREAM_SYNC_MODES).toEqual(['merge']);
			expect(APP_SPEC_POSTGRES_VERSIONS).toEqual(['14', '15', '16', '17']);
			expect(APP_SPEC_REDIS_VERSIONS).toEqual(['7']);
			expect(APP_SPEC_REDIS_MAXMEMORY_POLICIES).toEqual([
				'noeviction',
				'allkeys-lru',
				'volatile-lru',
				'allkeys-lfu',
				'volatile-lfu'
			]);
			expect(APP_SPEC_EVALUATION_TRIGGERS).toEqual([
				'created',
				'push',
				'pr_merged',
				'manual',
				'lazy',
				'blueprint_applied',
				'build'
			]);
			expect(APP_BLUEPRINT_APPLY_STATUSES).toEqual(['applying', 'applied', 'failed']);
		});
	});

	describe('every numeric constant of plan §3.2', () => {
		/** One row per constant: the name it is exported under, its value and the spec line. */
		const NUMERIC_CONSTANTS: Array<{
			name: string;
			actual: number | string | boolean | readonly string[];
			expected: number | string | boolean | readonly string[];
			spec: string;
		}> = [
			// plan.md §3.2:473-515 — the block T1 requires "every constant" of.
			{ name: 'APP_SPEC_VERSION', actual: APP_SPEC_VERSION, expected: 1, spec: 'plan.md:465' },
			{
				name: 'APP_SPEC_FILE_MAX_BYTES',
				actual: APP_SPEC_FILE_MAX_BYTES,
				expected: 262_144,
				spec: 'plan.md:474'
			},
			{ name: 'APP_SPEC_MAX_ISSUES', actual: APP_SPEC_MAX_ISSUES, expected: 200, spec: 'plan.md:475' },
			{
				name: 'APP_SPEC_YAML_MAX_ALIASES',
				actual: APP_SPEC_YAML_MAX_ALIASES,
				expected: 100,
				spec: 'plan.md:476'
			},
			{ name: 'APP_SPEC_MAX_DEPTH', actual: APP_SPEC_MAX_DEPTH, expected: 12, spec: 'plan.md:477' },
			{
				name: 'APP_SPEC_SUGGESTION_MAX_DISTANCE',
				actual: APP_SPEC_SUGGESTION_MAX_DISTANCE,
				expected: 2,
				spec: 'plan.md:478'
			},
			{
				name: 'APP_SPEC_EVALUATE_COALESCE_MS',
				actual: APP_SPEC_EVALUATE_COALESCE_MS,
				expected: 5_000,
				spec: 'plan.md:479'
			},
			{
				name: 'APP_SPEC_LAZY_HEAD_CHECK_MS',
				actual: APP_SPEC_LAZY_HEAD_CHECK_MS,
				expected: 60_000,
				spec: 'plan.md:480'
			},
			{
				name: 'APP_SPEC_DRAFT_VALIDATE_PER_MIN',
				actual: APP_SPEC_DRAFT_VALIDATE_PER_MIN,
				expected: 30,
				spec: 'plan.md:481'
			},
			{ name: 'APP_SPEC_REFRESH_PER_MIN', actual: APP_SPEC_REFRESH_PER_MIN, expected: 6, spec: 'plan.md:482' },
			{
				name: 'APPS_CATALOG_CACHE_TTL_MS',
				actual: APPS_CATALOG_CACHE_TTL_MS,
				expected: 3_600_000,
				spec: 'plan.md:483'
			},
			{
				name: 'APPS_CATALOG_FAILURE_TTL_MS',
				actual: APPS_CATALOG_FAILURE_TTL_MS,
				expected: 30_000,
				spec: 'plan.md:484'
			},
			{
				name: 'APPS_CATALOG_FETCH_TIMEOUT_MS',
				actual: APPS_CATALOG_FETCH_TIMEOUT_MS,
				expected: 8_000,
				spec: 'plan.md:485'
			},
			{
				name: 'APPS_CATALOG_MANIFEST_MAX_BYTES',
				actual: APPS_CATALOG_MANIFEST_MAX_BYTES,
				expected: 2_097_152,
				spec: 'plan.md:486'
			},
			{
				name: 'APPS_CATALOG_MAX_ENTRIES',
				actual: APPS_CATALOG_MAX_ENTRIES,
				expected: 1_000,
				spec: 'plan.md:487'
			},
			{
				name: 'APPS_CATALOG_REGISTRY_MAX_BYTES',
				actual: APPS_CATALOG_REGISTRY_MAX_BYTES,
				expected: 262_144,
				spec: 'plan.md:488'
			},
			{
				name: 'APPS_CATALOG_LAST_GOOD_REGISTRY_MS',
				actual: APPS_CATALOG_LAST_GOOD_REGISTRY_MS,
				expected: 604_800_000,
				spec: 'plan.md:489'
			},
			{ name: 'APPS_CATALOG_PAGE_SIZE', actual: APPS_CATALOG_PAGE_SIZE, expected: 24, spec: 'plan.md:490' },
			{
				name: 'APPS_CATALOG_PAGE_SIZE_MAX',
				actual: APPS_CATALOG_PAGE_SIZE_MAX,
				expected: 100,
				spec: 'plan.md:491'
			},
			{
				name: 'APPS_CATALOG_SEARCH_MIN_CHARS',
				actual: APPS_CATALOG_SEARCH_MIN_CHARS,
				expected: 2,
				spec: 'plan.md:492'
			},
			{
				name: 'APPS_CATALOG_README_MAX_BYTES',
				actual: APPS_CATALOG_README_MAX_BYTES,
				expected: 65_536,
				spec: 'plan.md:493'
			},
			{
				name: 'APPS_CATALOG_PUBLIC_PER_MIN',
				actual: APPS_CATALOG_PUBLIC_PER_MIN,
				expected: 120,
				spec: 'plan.md:494'
			},
			{
				name: 'APPS_CATALOG_FANOUT_PER_RUN',
				actual: APPS_CATALOG_FANOUT_PER_RUN,
				expected: 500,
				spec: 'plan.md:495'
			},
			{
				name: 'APPS_CATALOG_REFRESH_CRON',
				actual: APPS_CATALOG_REFRESH_CRON,
				expected: '23 * * * *',
				spec: 'plan.md:496'
			},
			{
				name: 'BLUEPRINT_RESOLVE_HIT_TTL_MS',
				actual: BLUEPRINT_RESOLVE_HIT_TTL_MS,
				expected: 3_600_000,
				spec: 'plan.md:497'
			},
			{
				name: 'BLUEPRINT_RESOLVE_MISS_TTL_MS',
				actual: BLUEPRINT_RESOLVE_MISS_TTL_MS,
				expected: 600_000,
				spec: 'plan.md:498'
			},
			{
				name: 'BLUEPRINT_PROBE_MAX_READS',
				actual: BLUEPRINT_PROBE_MAX_READS,
				expected: 3,
				spec: 'plan.md:499'
			},
			{
				name: 'BLUEPRINT_ALTERNATIVES_MAX',
				actual: BLUEPRINT_ALTERNATIVES_MAX,
				expected: 5,
				spec: 'plan.md:500'
			},
			{
				name: 'BLUEPRINT_OVERLAY_MAX_FILES',
				actual: BLUEPRINT_OVERLAY_MAX_FILES,
				expected: 50,
				spec: 'plan.md:501'
			},
			{
				name: 'BLUEPRINT_OVERLAY_FILE_MAX_BYTES',
				actual: BLUEPRINT_OVERLAY_FILE_MAX_BYTES,
				expected: 1_048_576,
				spec: 'plan.md:502'
			},
			{
				name: 'BLUEPRINT_OVERLAY_TOTAL_MAX_BYTES',
				actual: BLUEPRINT_OVERLAY_TOTAL_MAX_BYTES,
				expected: 5_242_880,
				spec: 'plan.md:503'
			},
			{ name: 'BLUEPRINT_APPLY_RETRIES', actual: BLUEPRINT_APPLY_RETRIES, expected: 3, spec: 'plan.md:504' },
			{ name: 'BLUEPRINT_APPLY_PER_HOUR', actual: BLUEPRINT_APPLY_PER_HOUR, expected: 5, spec: 'plan.md:505' },
			{
				name: 'LICENSE_TEXT_MATCH_THRESHOLD',
				actual: LICENSE_TEXT_MATCH_THRESHOLD,
				expected: 0.9,
				spec: 'plan.md:506'
			},
			{ name: 'LICENSE_MAX_FILE_READS', actual: LICENSE_MAX_FILE_READS, expected: 12, spec: 'plan.md:507' },
			{
				name: 'LICENSE_MIXED_DIR_NAMES',
				actual: LICENSE_MIXED_DIR_NAMES,
				expected: ['ee', 'enterprise', 'premium', 'commercial'],
				spec: 'plan.md:508'
			},
			{ name: 'LICENSE_MIXED_MAX_DEPTH', actual: LICENSE_MIXED_MAX_DEPTH, expected: 4, spec: 'plan.md:509' },
			{ name: 'LICENSE_EVIDENCE_MAX', actual: LICENSE_EVIDENCE_MAX, expected: 20, spec: 'plan.md:510' },
			{
				name: 'LICENSE_TREE_MAX_ENTRIES',
				actual: LICENSE_TREE_MAX_ENTRIES,
				expected: 100_000,
				spec: 'plan.md:511'
			},
			{
				name: 'LICENSE_HEADER_SCAN_BYTES',
				actual: LICENSE_HEADER_SCAN_BYTES,
				expected: 2_048,
				spec: 'plan.md:512'
			},
			{ name: 'LICENSE_ATTEST_PER_MIN', actual: LICENSE_ATTEST_PER_MIN, expected: 10, spec: 'plan.md:513' },
			{
				name: 'APPS_MANAGED_REQUIRES_VERIFIED',
				actual: APPS_MANAGED_REQUIRES_VERIFIED,
				expected: true,
				spec: 'plan.md:514'
			},
			// The two path-list caps T1 names (tasks.md:64) and the derived-name suffix of §12.
			{
				name: 'APP_SPEC_MAX_PROTECTED_PATHS',
				actual: APP_SPEC_MAX_PROTECTED_PATHS,
				expected: 50,
				spec: 'schema.md §8:164'
			},
			{
				name: 'APP_SPEC_MAX_REQUIRE_HUMAN_MERGE_PATHS',
				actual: APP_SPEC_MAX_REQUIRE_HUMAN_MERGE_PATHS,
				expected: 50,
				spec: 'schema.md §18:389'
			},
			{
				name: 'APP_SPEC_PUBLIC_KEY_SUFFIX',
				actual: APP_SPEC_PUBLIC_KEY_SUFFIX,
				expected: '_PUBLIC',
				spec: 'schema.md §12:276'
			}
		];

		it('covers the 42 plan-sourced constants and the three T1 adds', () => {
			expect(NUMERIC_CONSTANTS).toHaveLength(45);
		});

		it.each(NUMERIC_CONSTANTS)('pins $name = $expected ($spec)', ({ actual, expected }) => {
			expect(actual).toEqual(expected);
		});
	});

	describe('APP_SPEC_BLOCK_DEFAULTS — the web’s `default` marker (plan.md:620)', () => {
		it('carries only literal defaults and no holes', () => {
			const entries = Object.entries(APP_SPEC_BLOCK_DEFAULTS);

			expect(entries.length).toBeGreaterThan(50);
			expect(entries.filter(([, value]) => value === undefined)).toEqual([]);
		});

		it('pins one default per block, quoted from its schema.md row', () => {
			expect(APP_SPEC_BLOCK_DEFAULTS['build.dockerfile']).toBe('Dockerfile'); // §9:171
			expect(APP_SPEC_BLOCK_DEFAULTS['components[].replicas']).toBe(1); // §10:200
			expect(APP_SPEC_BLOCK_DEFAULTS['dependencies.postgres.version']).toBe('16'); // §11:219
			expect(APP_SPEC_BLOCK_DEFAULTS['env[].phase']).toBe('runtime'); // §12:248
			expect(APP_SPEC_BLOCK_DEFAULTS['env[].generate.keypair.format']).toBe('pem'); // §12:273
			expect(APP_SPEC_BLOCK_DEFAULTS['jobs[].timeoutSeconds']).toBe(600); // §13:329
			expect(APP_SPEC_BLOCK_DEFAULTS['cron[].concurrency']).toBe('forbid'); // §14:343
			expect(APP_SPEC_BLOCK_DEFAULTS['domains.onChange']).toBe('restart'); // §15:351
			expect(APP_SPEC_BLOCK_DEFAULTS['smoke[].when']).toBe('always'); // §16:369
			expect(APP_SPEC_BLOCK_DEFAULTS['checks[].timeoutSeconds']).toBe(1800); // §17:380
			expect(APP_SPEC_BLOCK_DEFAULTS['agents.requireHumanMergePaths']).toEqual([]); // §18:389
			expect(APP_SPEC_BLOCK_DEFAULTS['agents.maxPullRequestChangedLines']).toBe(500); // §18:387
			expect(APP_SPEC_BLOCK_DEFAULTS['upstreamSync.schedule']).toBe('0 6 * * 1'); // §19:398
			expect(APP_SPEC_BLOCK_DEFAULTS['upstreamPullRequests.requireApproval']).toBe(true); // §20:407
			expect(APP_SPEC_BLOCK_DEFAULTS['provisioning.autoReprovision']).toBe(false); // §20:414
		});
	});

	describe('isSourceOnlyAppSpec — the source-only boundary (tasks.md:276-285, R-4)', () => {
		it('is the same function at the package root', () => {
			expect(isSourceOnlyAppSpecFromRoot).toBe(isSourceOnlyAppSpec);
		});

		it('pins the three keys a source-only spec may hold (tasks.md:276-285)', () => {
			expect(APP_SPEC_SOURCE_ONLY_KEYS).toEqual(['kind', 'appSpecVersion', 'source']);
		});

		it('answers true for the minimal file APW-01 writes and for an empty spec', () => {
			expect(isSourceOnlyAppSpec({ source: { relation: 'fork' } })).toBe(true);
			expect(isSourceOnlyAppSpec({ kind: 'app', appSpecVersion: 1, source: { relation: 'fork' } })).toBe(true);
			expect(isSourceOnlyAppSpec({})).toBe(true);
		});

		it('ignores x- extension keys, at the top level and inside a block', () => {
			expect(isSourceOnlyAppSpec({ source: { relation: 'link' }, 'x-notes': 'local' })).toBe(true);
			expect(isSourceOnlyAppSpec({ source: { relation: 'link', 'x-note': 1 } })).toBe(true);
		});

		it('answers false as soon as one real block appears — the boundary T12 relies on', () => {
			// This is the pair `hasValidAppSpec` turns on: the first is a fresh,
			// source-only file; the second is an App spec somebody has written.
			expect(isSourceOnlyAppSpec({ source: { relation: 'fork' } })).toBe(true);
			expect(isSourceOnlyAppSpec({ source: { relation: 'fork' }, build: { strategy: 'dockerfile' } })).toBe(
				false
			);
			expect(isSourceOnlyAppSpec({ source: { relation: 'fork' }, components: [] })).toBe(false);
			expect(isSourceOnlyAppSpec({ source: { relation: 'fork' }, license: { spdx: 'MIT' } })).toBe(false);
			expect(isSourceOnlyAppSpec({ source: { relation: 'fork' }, display: { name: 'Cal.diy' } })).toBe(false);
		});

		it('fails closed for anything that is not a plain object', () => {
			// Nothing may read an unparseable value as the fresh path that R-4
			// commits to directly.
			expect(isSourceOnlyAppSpec(null)).toBe(false);
			expect(isSourceOnlyAppSpec(undefined)).toBe(false);
			expect(isSourceOnlyAppSpec('source')).toBe(false);
			expect(isSourceOnlyAppSpec(['source'])).toBe(false);
			expect(isSourceOnlyAppSpec(42)).toBe(false);
		});

		it('does not confuse an x- prefixed key with a real one', () => {
			// `x-` is the extension prefix, not "any key starting with x".
			expect(isSourceOnlyAppSpec({ source: {}, xtras: true })).toBe(false);
			expect(isSourceOnlyAppSpec({ source: {}, x: true })).toBe(false);
		});
	});

	describe('the hand-written types accept the specs’ own shapes', () => {
		it('accepts a full App spec — every block of schema.md §5–§20 in one object', () => {
			const spec: AppSpec = {
				kind: 'app',
				appSpecVersion: 1,
				source: { relation: 'fork', upstream: { repo: 'example-org/example-app', defaultBranch: 'main' } },
				blueprint: {
					id: 'example-app',
					version: '1.0.0',
					repo: 'ever-works/example-app-template',
					sha: '0123456789abcdef0123456789abcdef01234567'
				},
				license: { spdx: 'MIT', class: 'green', source: 'blueprint', notice: 'Example is a trademark.' },
				display: { name: 'Example (community build)', protectedPaths: ['public/brand/**'] },
				build: {
					strategy: 'auto',
					context: '.',
					args: [
						{ name: 'PUBLIC_URL', value: 'https://example.com' },
						{ name: 'BUILD_KEY', fromEnv: 'BUILD_KEY' }
					],
					services: [
						{ name: 'postgres', image: 'postgres:16', port: 5432, env: [{ name: 'X', value: 'y' }] }
					],
					resources: { cpu: 4, memory: '12Gi', timeoutMinutes: 60 }
				},
				components: [
					{
						name: 'web',
						role: 'web',
						command: ['/app/start.sh'],
						port: 3000,
						replicas: 1,
						writableRootFilesystem: true,
						runAsUser: 1000,
						probes: { readiness: { http: '/healthz' }, liveness: { tcp: true, periodSeconds: 30 } },
						resources: { cpu: '500m', memory: '1Gi', memoryLimit: '3Gi' },
						volumes: [{ name: 'data', path: '/data', size: '2Gi', backup: true }]
					}
				],
				dependencies: {
					postgres: { version: '16', directUrl: true, extensions: ['pgcrypto'] },
					redis: { version: '7', maxmemoryPolicy: 'noeviction', persistence: false },
					objectStorage: { buckets: ['uploads'], publicBuckets: ['uploads'] },
					smtp: { required: true }
				},
				env: [
					{
						name: 'SECRET',
						secret: true,
						phase: 'both',
						generate: {
							kind: 'keypair',
							keypair: { type: 'ec-p256', format: 'pkcs12', passwordEnv: 'KEY_PASSWORD' }
						},
						validate: { minLength: 1 },
						prompt: { description: 'Ask me', required: false, example: 'not-a-secret', group: 'auth' }
					},
					{
						name: 'KEY_PASSWORD',
						secret: true,
						generate: { kind: 'chars', length: 32, alphabet: 'alnum', rotate: 'never' }
					},
					{ name: 'DATABASE_URL', secret: true, from: 'deps.postgres.url' },
					{
						name: 'PUBLIC_URL',
						template: '{{domains.primary.url}}/api',
						phase: 'runtime',
						description: 'Public URL'
					},
					{ name: 'TELEMETRY', value: '0' }
				],
				jobs: [
					{
						name: 'migrate',
						when: 'pre-deploy',
						component: 'web',
						command: ['npx', 'prisma', 'migrate', 'deploy'],
						timeoutSeconds: 900,
						retries: 1
					}
				],
				cron: [
					{
						name: 'reminder',
						schedule: '*/15 * * * *',
						component: 'web',
						http: {
							method: 'POST',
							path: '/api/cron',
							authEnv: 'SECRET',
							authScheme: 'raw',
							body: { x: '{{env.TELEMETRY}}' },
							expect: { status: [200] }
						},
						timeoutSeconds: 300,
						concurrency: 'forbid'
					}
				],
				domains: {
					primaryComponent: 'web',
					publicUrlEnv: ['PUBLIC_URL'],
					onChange: 'restart',
					needsHairpin: true
				},
				smoke: [
					{
						name: 'health',
						http: { method: 'GET', path: '/healthz' },
						component: 'web',
						expect: {
							status: [200],
							bodyContains: ['ok'],
							bodyNotContains: ['localhost'],
							maxLatencyMs: 2_000
						},
						when: 'always'
					}
				],
				checks: [{ name: 'type-check', command: 'yarn type-check', required: true, timeoutSeconds: 1_800 }],
				agents: {
					instructionFiles: ['AGENTS.md'],
					maxPullRequestChangedLines: 500,
					maxPullRequestChangedFiles: 50,
					requireHumanMergePaths: ['db/migrations/**']
				},
				upstreamSync: { enabled: true, schedule: '0 6 * * 1', mode: 'merge', branch: 'main' },
				upstreamPullRequests: { enabled: true, requireApproval: true, maxOpen: 3 },
				provisioning: { autoReprovision: false }
			};

			expect(spec.components?.[0]?.runAsUser).toBe(1000);
			expect(spec.env?.[0]?.generate?.keypair?.format).toBe('pkcs12');
			expect(isSourceOnlyAppSpec(spec)).toBe(false);
		});

		it('accepts the §23 issue object with and without positions', () => {
			const withoutPositions: AppSpecIssue = {
				code: 'web_component_needs_port',
				severity: 'error',
				path: 'spec.components[0].port',
				pointer: '/spec/components/0/port',
				displayPath: 'components › web › port',
				message: 'Web components must declare the port they listen on.'
			};
			const positioned: AppSpecIssue = {
				...withoutPositions,
				line: 41,
				column: 7,
				hint: 'Add `port: <number>` under the `web` component.',
				params: { component: 'web' }
			};

			expect(withoutPositions.line).toBeUndefined();
			expect(positioned.line).toBe(41);
		});

		it('narrows the Blueprint resolution union on its discriminant', () => {
			const miss: BlueprintResolution = { matchSource: null, reason: 'refMismatch' };
			const match: BlueprintResolution = {
				matchSource: 'explicit',
				blueprintId: 'example-app',
				blueprintRepo: 'ever-works/example-app-template',
				blueprintSha: '0123456789abcdef0123456789abcdef01234567',
				verified: false,
				confirmationRequired: true,
				upstreamRepo: 'example-org/example-app'
			};

			expect(miss.matchSource === null ? miss.reason : null).toBe('refMismatch');
			expect(match.matchSource === null ? null : match.blueprintId).toBe('example-app');
		});

		it('accepts a catalog entry, a spec summary and a complete state DTO', () => {
			const specSummary: AppsCatalogSpecSummary = {
				components: 1,
				dependencies: ['postgres', 'smtp'],
				promptedVariables: 2
			};
			const entry: AppsCatalogEntry = {
				id: 'example-app',
				name: 'Example',
				summary: 'An example app.',
				icon: 'icons/example-app.svg',
				category: 'productivity',
				status: 'beta',
				upstreams: [{ repo: 'example-org/example-app', refs: { branches: ['main'], exclude: ['v1.*'] } }],
				blueprint: { repo: 'ever-works/example-app-template', version: '1.0.0', sha: '0'.repeat(40) },
				license: { spdx: 'MIT', class: 'green' },
				managedHosting: { allowed: true },
				minResources: { cpu: '500m', memory: '1Gi' },
				dependencies: ['postgres'],
				verified: false,
				managed: 'available',
				yourCluster: true
			};
			const dto: WorkAppSpecStateDto = {
				id: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f',
				workId: '1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f',
				tenantId: null,
				organizationId: null,
				trackedBranch: 'main',
				dispatchedAt: null,
				headCommitSha: '0123456789abcdef0123456789abcdef01234567',
				headSpecHash: 'a'.repeat(64),
				validationStatus: 'invalid',
				issues: [
					{
						code: 'web_component_needs_port',
						severity: 'error',
						path: 'spec.components[0].port',
						pointer: '/spec/components/0/port',
						displayPath: 'components › web › port',
						line: 41,
						column: 7,
						message: 'Web components must declare the port they listen on.'
					}
				],
				errorCount: 1,
				warningCount: 0,
				issuesTruncated: false,
				effectiveCommitSha: '1111111111111111111111111111111111111111',
				effectiveSpecHash: 'b'.repeat(64),
				effectiveSpec: { source: { relation: 'fork' } },
				effectiveAt: '2026-09-17T00:00:00.000Z',
				lastEvaluatedAt: '2026-09-17T00:00:00.000Z',
				lastEvaluationTrigger: 'push',
				lastEvaluationError: null,
				blueprintId: 'example-app',
				blueprintVersion: '1.0.0',
				blueprintRepo: 'ever-works/example-app-template',
				blueprintSha: '2222222222222222222222222222222222222222',
				blueprintMatchSource: 'manifest',
				blueprintApplyStatus: 'applied',
				blueprintMatchedAt: '2026-09-17T00:00:00.000Z',
				blueprintApplyError: null,
				blueprintApplyRef: {
					kind: 'commit',
					sha: '3333333333333333333333333333333333333333',
					url: 'https://example.com/commit'
				},
				blueprintLatestVersion: '1.1.0',
				blueprintUpgradeDismissedVersion: null,
				blueprintUpgradePr: { number: 1, url: 'https://example.com/pr/1', version: '1.1.0', breaking: false },
				licenseSpdx: 'MIT',
				licenseClass: 'green',
				licenseSource: 'detected',
				licenseMixed: false,
				licenseScanIncomplete: false,
				licenseEvidence: {
					files: ['LICENSE'],
					mixedPaths: [],
					headerFindings: [{ path: 'src/index.ts', spdx: 'MIT' }]
				},
				licenseObligations: ['attribution'],
				licenseCommitSha: '0123456789abcdef0123456789abcdef01234567',
				licenseRegistryHash: 'c'.repeat(64),
				licenseRegistrySource: 'live',
				licenseEvaluatedAt: '2026-09-17T00:00:00.000Z',
				attestation: null,
				sourceOfferRequired: false,
				displayName: 'Example (community build)',
				trademarkNotice: 'Example is a trademark.',
				protectedPaths: ['public/brand/**'],
				createdAt: '2026-09-17T00:00:00.000Z',
				updatedAt: '2026-09-17T00:00:00.000Z',
				evaluationPending: false,
				links: {
					file: {
						base: 'https://github.com/ever-works/example-app/blob/0123456789abcdef0123456789abcdef01234567/.works/works.yml',
						commitSha: '0123456789abcdef0123456789abcdef01234567',
						path: '.works/works.yml'
					},
					lineAnchor: '#L{line}'
				}
			};

			expect(specSummary.promptedVariables).toBe(2);
			expect(entry.managed).toBe('available');
			expect(dto.issues?.[0]?.code).toBe('web_component_needs_port');
		});
	});

	describe('buildAppSpecLineLink — the file link with the provider’s anchor (plan.md:578-580)', () => {
		const links = {
			file: {
				base: 'https://github.com/ever-works/example-app/blob/0123456789abcdef0123456789abcdef01234567/.works/works.yml',
				commitSha: '0123456789abcdef0123456789abcdef01234567',
				path: '.works/works.yml'
			},
			lineAnchor: '#L{line}'
		};

		it('appends the provider’s anchor for a real line', () => {
			expect(buildAppSpecLineLink(links, 41)).toBe(`${links.file.base}#L41`);
		});

		it('falls back to the file when there is no line, no anchor or no placeholder', () => {
			expect(buildAppSpecLineLink(links)).toBe(links.file.base);
			expect(buildAppSpecLineLink(links, 0)).toBe(links.file.base);
			expect(buildAppSpecLineLink(links, -1)).toBe(links.file.base);
			expect(buildAppSpecLineLink(links, 1.5)).toBe(links.file.base);
			expect(buildAppSpecLineLink({ ...links, lineAnchor: null }, 41)).toBe(links.file.base);
			expect(buildAppSpecLineLink({ ...links, lineAnchor: '#L' }, 41)).toBe(links.file.base);
		});
	});
});
