/**
 * App Works — the App source model: how an App Work relates to the repository
 * it was made from, plus the inspect (preview) and create contracts both doors
 * share.
 *
 * Owning epic: **APW-01** (App Work kind & create from any repository URL).
 * The persisted source record and the App spec's `source` block are APW-01's
 * (CONTRACTS.md §1 `source`, §2, §2A), so they live here and APW-03/04/09/11
 * read them rather than restating them.
 *
 * Spec: `docs/specs/features/app-works/APW-01-app-work-kind/spec.md`
 * Plan: `docs/specs/features/app-works/APW-01-app-work-kind/plan.md` §3.2
 * Bindings: `docs/specs/features/app-works/CONTRACTS.md` §0 (R-1, R-2, R-12),
 * §2, §2A, §7A, §12.
 *
 * Three things this file deliberately does NOT do:
 *  - it does not redeclare `RepositoryRole`, `RelatedRepositories`,
 *    `ImportSourceType` or `SourceRepository` — they already ship in
 *    `../api/work/import-source.dto.ts` and are imported here;
 *  - it does not widen `IMPORT_SOURCE_TYPES` (Work Import validates against it,
 *    CONTRACTS.md §2) — the `app_*` types are a separate closed set;
 *  - it declares no canonical App-spec type (`LicenseClass`,
 *    `BlueprintMatchSource`, `AppSpec` …): those are APW-03's, and the preview
 *    subsets here carry source-prefixed names on purpose so the apps barrel can
 *    never see the same export twice.
 */

import type {
	ImportSourceType,
	RelatedRepositories,
	RepositoryRole,
	SourceRepository
} from '../api/work/import-source.dto.js';

import type { AppReadinessState } from './app-upstream.js';

// ---------------------------------------------------------------------------
// The source record (APW-01 §5.1; CONTRACTS.md §2)
// ---------------------------------------------------------------------------

/**
 * The persisted `works.sourceRepository.type` values an App Work may carry
 * (APW-01 plan.md:293, CONTRACTS.md:266).
 *
 * A new constant on purpose: `IMPORT_SOURCE_TYPES` is **not** widened, because
 * Work Import validates against it and an imported entry must never become an
 * App Work (APW-01 FR-54).
 */
export const APP_SOURCE_REPOSITORY_TYPES = ['app_link', 'app_fork', 'app_private_copy'] as const;

/** Union derived from {@link APP_SOURCE_REPOSITORY_TYPES}. */
export type AppSourceRepositoryType = (typeof APP_SOURCE_REPOSITORY_TYPES)[number];

/**
 * The upstream a fork or private copy follows (APW-01 plan.md:295-299).
 *
 * This is the **persisted** shape (`{ owner, repo }`); the App spec's own
 * `source.upstream.repo` is the single `owner/name` string — see
 * {@link AppSourceBlock}.
 */
export interface AppUpstreamRef {
	owner: string;
	repo: string;
	defaultBranch: string;
}

/**
 * The role the App Work's code repository is persisted under — **`website`**,
 * whose UI label is literally "Work Repository" (APW-01 FR-2, CONTRACTS.md
 * §2 vocabulary fix). It is never `data`: `data` holds the Work's *content*.
 *
 * Reused from the shipping DTO rather than redeclared, so the two cannot drift.
 */
export const APP_WORK_REPOSITORY_ROLE: RepositoryRole = 'website';

/**
 * The relation (mode) the member chose, as every API surface spells it
 * (APW-01 plan.md:325; openapi `AppWorkCreateRequest.repositoryMode`).
 *
 * The nine deploy-target literals of R-12 are the *other* axis; this one is
 * "how did we get a Work Repository".
 */
export const APP_REPOSITORY_MODES = ['link', 'fork', 'private-copy'] as const;

/** Union derived from {@link APP_REPOSITORY_MODES}. */
export type AppRepositoryMode = (typeof APP_REPOSITORY_MODES)[number];

/**
 * Mode → persisted source type (CONTRACTS.md:266). One entry per mode and no
 * value twice, so a reader can never map two modes onto one record.
 */
export const APP_SOURCE_REPOSITORY_TYPE_BY_MODE: Readonly<Record<AppRepositoryMode, AppSourceRepositoryType>> = {
	link: 'app_link',
	fork: 'app_fork',
	'private-copy': 'app_private_copy'
};

/**
 * The Work Repository name suffixes (APW-01 FR-20a, spec.md:341-349).
 *
 * `-app` when the App Work was created from an app template, `-website`
 * otherwise — the unchanged default for Website/Work Templates and for every
 * non-`app` kind. A naming convention ONLY: the persisted role stays
 * {@link APP_WORK_REPOSITORY_ROLE} and no new role value is added.
 */
export const APP_SOURCE_REPOSITORY_NAME_SUFFIXES = { app: '-app', default: '-website' } as const;

/** The Work Repository file that carries the App spec (APW-01 FR-29, spec.md:374). */
export const APP_SOURCE_SPEC_FILE = '.works/works.yml';

/** The spec version an App Work records — `.works/works.yml` version 2 (spec.md:374). */
export const APP_SOURCE_SPEC_VERSION = 2;

/** The kind discriminator an App Work records (spec.md:375). */
export const APP_SOURCE_SPEC_KIND = 'app';

/**
 * The App spec's `source` block as written into the Work Repository
 * (APW-01 FR-29, CONTRACTS.md:102-105, APW-03 schema.md §5).
 *
 * Field names are the schema's, not this file's: `upstream.repo` is the single
 * `owner/name` string, and `branch` is the Work Repository branch that is built
 * and deployed. `relation` must equal the relation recorded at creation
 * (`source_relation_mismatch`, schema.md:119-120) — a hand edit cannot turn a
 * fork into a link.
 */
export interface AppSourceBlock {
	/** `link` · `fork` · `private-copy` (schema.md:114). */
	relation: AppRepositoryMode;
	/** Absent when `relation` is `link`, which forbids it (schema.md:115, R13). */
	upstream?: {
		/** `owner/name`, matching `^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$`. */
		repo: string;
		/** Upstream's default branch at creation; a Git ref name, 1–255 chars. */
		defaultBranch?: string;
	};
	/** The Work Repository branch that is built and deployed; 1–255 chars. */
	branch?: string;
}

/**
 * `works.sourceRepository` for `kind: app` (APW-01 plan.md:240).
 *
 * Extends the shipping {@link SourceRepository} so the shared fields
 * (`url`, `owner`, `repo`, `importedAt`, `relatedRepositories`) keep exactly one
 * definition; `type` is narrowed to the three `app_*` values. Top-level
 * `owner`/`repo` are the **Work Repository** (the `website` role) — the app-code
 * fork is recorded there, never under `data` (CONTRACTS.md:267).
 *
 * `worksConfig` is inherited from the shared shape and is deliberately kept:
 * FR-43 forbids *writing* generator settings into an App Work's file, and
 * removing the field would narrow a shape other readers still type against.
 */
export interface AppSourceRecord<TImportedAt = string> extends Omit<SourceRepository<TImportedAt>, 'type'> {
	type: AppSourceRepositoryType;
	/** Present for `fork` and `private-copy`; absent for `link`. */
	upstream?: AppUpstreamRef;
	/** The Blueprint resolved server-side at create time (APW-01 FR-29b). */
	blueprintId?: string;
	/** How that Blueprint was matched, so every caller sees the same decision. */
	blueprintMatchSource?: AppSourceBlueprintMatchSource;
	/** True only when THIS creation issued the fork request or made the copy (R-4). */
	createdByThisWork?: boolean;
	/**
	 * The member's decline of FR-29a's automatic start (App spec plan.md:240,
	 * APW-01 plan.md §3.1, §4.2 step 10).
	 *
	 * **Written only when the member declined**, so an absent property means "on":
	 * no migration, no backfill, and no existing caller or stored row changes
	 * meaning. It is what `AppSourceInitializerService` step 8 reads to skip the
	 * automatic provisioning start, leaving the Overview's Provisioning card in its
	 * **Not started** state with a **Provision** button instead. It is never cleared
	 * automatically.
	 *
	 * `boolean` rather than the literal `false` so a future "explicitly on" value is
	 * expressible without changing this shape (R-26, additive only).
	 */
	autoProvision?: boolean;
}

/**
 * The value `SourceRepository.type` accepts once APW-01's widening lands
 * (plan.md:310). Declared here so that edit — which belongs to
 * `../api/work/import-source.dto.ts`, not to this file — has one name to import.
 */
export type WorkSourceRepositoryType = ImportSourceType | AppSourceRepositoryType;

/** Re-exported for readers of an App source record; the DTO is the definition. */
export type AppSourceRelatedRepositories = RelatedRepositories;

// ---------------------------------------------------------------------------
// Deploy target (APW-01 FR-33/FR-34, resolution R-12)
// ---------------------------------------------------------------------------

/**
 * The three deploy targets, and the ONLY definition of them
 * (CONTRACTS.md:335): APW-06 imports and re-exports this as
 * `APP_DEPLOY_TARGETS` instead of writing a second array.
 *
 * `none` is "None — don't deploy yet" and is the default; there is no separate
 * deferred-deploy state (R-12, CONTRACTS.md:55).
 */
export const APP_DEPLOY_TARGET_CHOICES = ['none', 'your-cluster', 'ever-works-apps'] as const;

/** Union derived from {@link APP_DEPLOY_TARGET_CHOICES}. */
export type AppDeployTargetChoice = (typeof APP_DEPLOY_TARGET_CHOICES)[number];

// ---------------------------------------------------------------------------
// Reason codes (APW-01 §6.3)
// ---------------------------------------------------------------------------

/**
 * The closed set of user-facing inspect and create reason codes — the 24 rows of
 * APW-01 spec §6.3 (spec.md:606-633), in table order. Append-only: a member is
 * never renamed or removed, and a code is never reused for another situation
 * (CONTRACTS.md §12).
 */
export const APP_SOURCE_REASON_CODES = [
	'invalid_url',
	'provider_not_connected',
	'insufficient_scope',
	'not_found',
	'sso_authorization_required',
	'oauth_app_restricted',
	'empty_repository',
	'no_push_access',
	'archived',
	'forking_disabled',
	'own_repository',
	'target_owner_unavailable',
	'target_owner_forbidden',
	'too_large_for_private_copy',
	'uses_lfs',
	'copy_name_unavailable',
	'in_use_by_another_account',
	'app_work_exists',
	'create_in_progress',
	'rate_limited',
	'managed_hosting_unavailable',
	'cluster_target_unavailable',
	'app_works_disabled',
	'blueprint_mismatch'
] as const;

/** Union derived from {@link APP_SOURCE_REASON_CODES}. */
export type AppSourceReasonCode = (typeof APP_SOURCE_REASON_CODES)[number];

/**
 * Fail-closed guard for a reason code arriving off the wire, out of a job
 * payload or out of a test fixture: anything that is not a member is `false`,
 * never a coerced string.
 */
export function isAppSourceReasonCode(value: unknown): value is AppSourceReasonCode {
	return typeof value === 'string' && (APP_SOURCE_REASON_CODES as readonly string[]).includes(value);
}

/**
 * Whether a mode or a deploy target is offered, and — when it is not — the ONE
 * stable code that explains it (APW-01 FR-5, FR-12, FR-33).
 *
 * `reason` is absent exactly when `available` is true, so a disabled option
 * always has text a card, a test id and a translation key can be derived from.
 */
export interface AppModeAvailability {
	available: boolean;
	reason?: AppSourceReasonCode;
}

/**
 * A deploy target's availability (APW-01 FR-33/FR-34, tasks.md:82-83).
 *
 * `providerId` is set only when the target is available **and** is not `none`
 * — it is the plugin the create request persists, from which APW-06 derives the
 * runtime's target exactly once (FR-34).
 */
export interface AppDeployTargetAvailability extends AppModeAvailability {
	providerId?: string;
}

// ---------------------------------------------------------------------------
// Blueprint preview (APW-01 FR-29b/FR-55; APW-03 §4.4)
// ---------------------------------------------------------------------------

/** The three states a Blueprint preview can be in (plan.md:396, openapi:228). */
export const APP_SOURCE_BLUEPRINT_STATUSES = ['matched', 'none', 'unavailable'] as const;

/** Union derived from {@link APP_SOURCE_BLUEPRINT_STATUSES}. */
export type AppSourceBlueprintStatus = (typeof APP_SOURCE_BLUEPRINT_STATUSES)[number];

/**
 * How the Blueprint was matched (APW-01 plan.md:240).
 *
 * APW-03 owns the canonical `BlueprintMatchSource` (CONTRACTS.md §2A); this is
 * the source record's spelling of the same five members and carries the prefix
 * so the apps barrel never re-exports one name twice.
 */
export const APP_SOURCE_BLUEPRINT_MATCH_SOURCES = ['manifest', 'alias', 'fork', 'probe', 'explicit'] as const;

/** Union derived from {@link APP_SOURCE_BLUEPRINT_MATCH_SOURCES}. */
export type AppSourceBlueprintMatchSource = (typeof APP_SOURCE_BLUEPRINT_MATCH_SOURCES)[number];

/**
 * One prompted value a Blueprint asks for (APW-01 FR-55, tasks.md:85).
 *
 * **Never a value**: the preview shows the name, the description and whether
 * the value is required; the member's answers travel write-only on the create
 * request and are never echoed by any read.
 */
export interface AppBlueprintPrompt {
	name: string;
	description?: string;
	required: boolean;
}

/** The Blueprint the create preview shows and the platform settles server-side. */
export interface AppBlueprintPreview {
	status: AppSourceBlueprintStatus;
	id?: string;
	version?: string;
	verified?: boolean;
	/** Display name, shown when present (APW-01 tasks.md:778). */
	name?: string;
	/** The entry's trademark notice, shown when present (APW-01 tasks.md:778). */
	notice?: string;
	matchSource?: AppSourceBlueprintMatchSource;
	prompts?: AppBlueprintPrompt[];
}

// ---------------------------------------------------------------------------
// License preview (APW-01 FR-8, Resolution R-3)
// ---------------------------------------------------------------------------

/**
 * The four license classes (APW-01 FR-8, R-3 in CONTRACTS.md:46).
 *
 * `unknown` is a first-class answer, never a guessed class: when the lookup is
 * unavailable inspect still answers, with the license marked unknown.
 */
export const APP_SOURCE_LICENSE_CLASSES = ['green', 'amber', 'red', 'unknown'] as const;

/** Union derived from {@link APP_SOURCE_LICENSE_CLASSES}. */
export type AppSourceLicenseClass = (typeof APP_SOURCE_LICENSE_CLASSES)[number];

/** The three evidence sources of the App spec's `license` block (APW-03 schema.md:143). */
export const APP_SOURCE_LICENSE_SOURCES = ['detected', 'blueprint', 'user'] as const;

/** Union derived from {@link APP_SOURCE_LICENSE_SOURCES}. */
export type AppSourceLicenseSource = (typeof APP_SOURCE_LICENSE_SOURCES)[number];

/**
 * The license preview inspect returns (plan.md:402).
 *
 * `source` cannot be `user` here: nothing is persisted before create, so the
 * only evidence available is what was detected or what the Blueprint declares.
 */
export interface AppSourceLicensePreview {
	spdx: string | null;
	class: AppSourceLicenseClass;
	source: Exclude<AppSourceLicenseSource, 'user'>;
}

// ---------------------------------------------------------------------------
// Inspect (APW-01 FR-5 … FR-10)
// ---------------------------------------------------------------------------

/** What inspect is asked for (openapi `AppSourceInspectRequest`). */
export interface AppSourceInspectRequest {
	/** GitHub repository URL; trimmed before parsing, at most 400 characters (FR-6). */
	repositoryUrl: string;
	/** Validated against the URL parser's host rules, not a literal list. */
	gitProvider?: string;
	/**
	 * A catalog id. When sent, the resolver previews exactly that entry; when it
	 * does not match the repository, create answers `blueprint_mismatch`
	 * (APW-01 FR-56).
	 */
	blueprintId?: string;
}

/**
 * One owner the caller can fork into, with the state of its existing-fork check
 * (APW-01 FR-9, plan.md:192-194).
 *
 * `existingForkChecked` is REQUIRED: an owner the 15-call budget did not reach
 * keeps its computed `available`, carries **no** reason code and is reported as
 * not checked — never as "no fork". Creating into it still adopts a fork that
 * exists there (FR-19).
 */
export interface AppTargetOwner {
	login: string;
	type: 'user' | 'organization';
	available: boolean;
	reason?: AppSourceReasonCode;
	/** Present only when the scan reached this owner and found a fork. */
	existingFork?: { owner: string; repo: string; fullName: string; url: string; inUseByAnotherAccount: boolean };
	existingForkChecked: boolean;
}

/**
 * The inspection result (plan.md:371-406; openapi `AppSourceInspectResponse`).
 *
 * Inspect writes nothing: no repository, no row, no Activity, no file (FR-5),
 * which is why a provider-side refusal still answers 200 with every mode marked
 * unavailable and a classified reason.
 */
export interface AppSourceInspectResponse {
	repository: {
		owner: string;
		repo: string;
		fullName: string;
		url: string;
		description?: string;
		defaultBranch: string;
		stars: number;
		sizeKb: number;
		visibility: 'public' | 'private' | 'internal';
		archived: boolean;
		empty: boolean;
		isFork: boolean;
		/** The immediate parent, when the repository is a fork. */
		parent?: string;
		/** The fork network's root, when the provider reports one. */
		source?: string;
		allowForking: boolean;
		/** Set when the repository moved; the old coordinates (APW-02 FR-15). */
		movedFrom?: string;
		usesLfs: boolean;
	};
	access: { canPush: boolean; canAdmin: boolean };
	modes: Record<AppRepositoryMode, AppModeAvailability>;
	/** `null` when neither Link nor Fork is available. */
	defaultMode: AppRepositoryMode | null;
	/** The caller first, then the offered organizations A–Z (≤ 30 in P1, ≤ 200 in P2). */
	targetOwners: AppTargetOwner[];
	blueprint: AppBlueprintPreview;
	/** `source` is `detected` or `blueprint`; `unknown` is a real answer (FR-8). */
	license: AppSourceLicensePreview;
	deployTargets: Record<AppDeployTargetChoice, AppDeployTargetAvailability>;
	/** The CALLER's own existing App Work — never another account's. */
	existingAppWork?: { id: string; name: string; slug: string };
	/**
	 * True when the existing-fork scan did not reach every offered owner
	 * (APW-01 FR-9, tasks.md:84-85).
	 *
	 * Required, not optional: a client that forgets it would silently render a
	 * partial scan as complete. (APW-01 tasks.md:748 later calls it optional,
	 * which would weaken this; R-26 forbids that, so the required reading wins.)
	 */
	scanIncomplete: boolean;
	/** ISO timestamp, present when `rate_limited` refused something. */
	retryAfter?: string;
}

/**
 * The repository facts the mode resolver reads. Deliberately narrower than
 * {@link AppSourceInspectResponse} so it can be built from a provider read, a
 * cached inspect or a test fixture without inventing a response.
 */
export interface AppRepositoryModeFacts {
	canPush: boolean;
	archived: boolean;
	empty: boolean;
	allowForking: boolean;
	usesLfs: boolean;
	/** The provider-reported size in KB; absent or unmeasurable fails closed. */
	sizeKb?: number | null;
	visibility: 'public' | 'private' | 'internal';
	/** The pasted repository is itself a fork. */
	isFork: boolean;
	/** The member owns this repository in the target account (FR-18). */
	isOwnRepository: boolean;
	/** Another account already uses this repository in Ever Works (FR-26). */
	isInUseByAnotherAccount: boolean;
}

/** The resolver's answer: every mode, plus the one the form should pre-select. */
export interface AppRepositoryModeResolution {
	modes: Record<AppRepositoryMode, AppModeAvailability>;
	defaultMode: AppRepositoryMode | null;
}

/** First condition that holds, in the order the requirement lists it. */
function firstReason(
	candidates: Array<[matches: boolean, reason: AppSourceReasonCode]>
): AppSourceReasonCode | undefined {
	for (const [matches, reason] of candidates) {
		if (matches) {
			return reason;
		}
	}
	return undefined;
}

/**
 * Which modes the create form may offer, and which one it pre-selects —
 * FR-17, FR-18 and FR-20 exactly, in the order those requirements list their
 * conditions, so a disabled card always has the reason the spec gives it.
 *
 * Fails closed on an unmeasurable `sizeKb`: a repository whose size could not be
 * read is NOT offered as a private copy, because "we could not measure it" must
 * never be rendered as "it fits".
 */
export function resolveAppRepositoryModes(factsInput: AppRepositoryModeFacts): AppRepositoryModeResolution {
	const linkReason = firstReason([
		[!factsInput.canPush, 'no_push_access'],
		[factsInput.archived, 'archived'],
		[factsInput.isInUseByAnotherAccount, 'in_use_by_another_account']
	]);

	const forkReason = firstReason([
		[!factsInput.allowForking, 'forking_disabled'],
		[factsInput.empty, 'empty_repository'],
		[factsInput.isOwnRepository, 'own_repository']
	]);

	const sizeKnown =
		typeof factsInput.sizeKb === 'number' && Number.isFinite(factsInput.sizeKb) && factsInput.sizeKb >= 0;
	const copyReason = firstReason([
		[!sizeKnown || (factsInput.sizeKb as number) > APP_PRIVATE_COPY_MAX_SIZE_KB, 'too_large_for_private_copy'],
		[factsInput.usesLfs, 'uses_lfs'],
		[factsInput.visibility === 'private' && !factsInput.allowForking, 'forking_disabled']
	]);

	const modes: Record<AppRepositoryMode, AppModeAvailability> = {
		link: linkReason ? { available: false, reason: linkReason } : { available: true },
		fork: forkReason ? { available: false, reason: forkReason } : { available: true },
		'private-copy': copyReason ? { available: false, reason: copyReason } : { available: true }
	};

	// FR-17: Link is the default when the member can push to a repository that is
	// not a fork. FR-18: Fork is the default when the member cannot push, or when
	// the pasted repository is itself a fork the member can push to. When neither
	// rule applies, an available Link is still the fallback and `null` says the
	// form must not pre-select anything.
	let defaultMode: AppRepositoryMode | null = null;
	if (modes.link.available && factsInput.canPush && !factsInput.isFork) {
		defaultMode = 'link';
	} else if (modes.fork.available && (!factsInput.canPush || factsInput.isFork)) {
		defaultMode = 'fork';
	} else if (modes.link.available) {
		defaultMode = 'link';
	}

	return { modes, defaultMode };
}

// ---------------------------------------------------------------------------
// Create, response and delete (APW-01 FR-11 … FR-40b)
// ---------------------------------------------------------------------------

/**
 * The fields APW-01 ADDS to the existing create request (plan.md:421-428;
 * openapi `AppWorkCreateRequest`). The rest of the create DTO is unchanged and
 * is deliberately not restated here.
 */
export interface AppWorkCreateRequest {
	kind: 'app';
	repositoryUrl: string;
	/** Required for `kind: app`; the three {@link APP_REPOSITORY_MODES}. */
	repositoryMode?: AppRepositoryMode;
	/** Required for `fork` and `private-copy`; the caller's account or organization. */
	targetOwner?: string;
	/** The supported way to give a Blueprint to a repository no catalog entry lists (APW-03 FR-81). */
	blueprintId?: string;
	/**
	 * Write-only prompted App env values (APW-01 FR-55). Never echoed by any
	 * read; handed to APW-07 and stored encrypted once the App spec exists.
	 */
	appEnv?: Record<string, string>;
}

/**
 * The `appSource` block of the create answer (openapi:274-282).
 *
 * Every client — form, chat, MCP server, command line — reads the platform's
 * own decision here instead of re-deriving it.
 */
export interface AppSourceCreatedView {
	relation: AppRepositoryMode;
	/** `preparing` on create; the closed set is APW-02's `APP_READINESS_STATES`. */
	readiness: AppReadinessState;
	dataRepository: { owner: string; repo: string; url?: string };
	/** Absent for `link`. */
	upstream?: AppUpstreamRef;
	deployTarget: AppDeployTargetChoice;
	/** The Blueprint the platform settled server-side (APW-01 FR-29b). */
	blueprint?: { id: string; version?: string; name?: string; matchSource?: AppSourceBlueprintMatchSource };
}

/** The create answer (openapi `AppWorkCreateResponse`). */
export interface AppWorkCreateResponse {
	status: 'success';
	appSource?: AppSourceCreatedView;
	/** Present and true when an equivalent App Work already existed (FR-23). */
	alreadyExisted?: boolean;
}

/**
 * The delete body's App-Work fields (openapi:160-173, plan.md:433-435).
 *
 * `delete_data_repository` keeps its existing meaning — the fork or the private
 * copy (FR-38) — and is refused for a `link` relation. `delete_stored_data` is a
 * SEPARATE choice (R-15) and needs `confirm_slug` to equal the App Work's slug,
 * checked server-side before anything else happens (FR-40b). Omitting either
 * flag means "keep" for every caller, including chat and MCP (FR-39).
 */
export interface AppWorkDeleteRequest {
	delete_data_repository?: boolean;
	delete_stored_data?: boolean;
	confirm_slug?: string;
}

/** The shared error body for the App-source routes (openapi `AppSourceError`). */
export interface AppSourceErrorBody {
	status: 'error';
	code: AppSourceReasonCode;
	message: string;
	/** Only the caller's own identifiers ever appear here (FR-51). */
	details?: { owner?: string; fullName?: string; workId?: string; workName?: string; retryAfter?: string };
}

// ---------------------------------------------------------------------------
// Numeric limits (APW-01 plan.md:408-416 and the FRs they come from)
// ---------------------------------------------------------------------------

/**
 * At most 15 provider API calls per inspect, the existing-fork scan included
 * (APW-01 FR-7, spec.md:290). The single biggest number in the create path.
 */
export const APP_INSPECT_MAX_PROVIDER_CALLS = 15;

/**
 * The fixed checks that precede the fork scan — repository read 1, default-branch
 * read at most 1, caller read 1, organizations read 1, `.gitattributes` read 1 —
 * bounded so the scan always has room (APW-01 FR-9, spec.md:302, plan.md:187-190).
 */
export const APP_INSPECT_FIXED_PROVIDER_CALLS = 5;

/**
 * A new owner is started only while at least this many calls remain
 * (APW-01 FR-9, spec.md:303, plan.md:191).
 */
export const APP_INSPECT_OWNER_MIN_CALLS_REMAINING = 3;

/** Whether the budget still allows starting the scan of one more owner. */
export function canStartTargetOwnerScan(callsRemaining: number): boolean {
	return Number.isFinite(callsRemaining) && callsRemaining >= APP_INSPECT_OWNER_MIN_CALLS_REMAINING;
}

/** Inspect answers within 8 seconds at p95 (APW-01 FR-7, spec.md:291). */
export const APP_INSPECT_P95_BUDGET_MS = 8_000;

/** Inspect caches its answer per member and repository for 60 seconds (spec.md:291). */
export const APP_INSPECT_CACHE_TTL_MS = 60_000;

/** Inspect is rate-limited to 30 requests per minute per member (spec.md:292). */
export const APP_INSPECT_RATE_LIMIT_PER_MINUTE = 30;

/** Owners offered in P1: the caller's account first, then organizations A–Z (spec.md:300). */
export const APP_TARGET_OWNER_SCAN_LIMIT_P1 = 30;

/** Owners offered in P2 — the same scan, paginated further (spec.md:300, tasks.md:745). */
export const APP_TARGET_OWNER_SCAN_LIMIT_P2 = 200;

/**
 * The private copy ceiling, 500 MB as GitHub reports size in KB
 * (APW-01 FR-20, spec.md:337, plan.md:412).
 *
 * APW-02 imports THIS constant for `createRepositoryCopy({ maxSizeKb })`; it is
 * never restated (plan.md:460-461).
 */
export const APP_PRIVATE_COPY_MAX_SIZE_KB = 512_000;

/**
 * How many names a private copy may try: the copy, then `-copy-2` … `-copy-5`
 * (APW-01 FR-20, spec.md:340, plan.md:413).
 */
export const APP_PRIVATE_COPY_NAME_ATTEMPTS = 5;

/** Concurrent creates for one member/upstream/mode/owner are serialised this long (FR-22, spec.md:356). */
export const APP_CREATE_LOCK_TTL_MS = 120_000;

/** The idempotency window: an identical create returns the same App Work (FR-23, spec.md:358). */
export const APP_CREATE_IDEMPOTENCY_WINDOW_MS = 600_000;

/** The create response returns within 10 seconds and never waits for a fork (FR-21, spec.md:350). */
export const APP_CREATE_RESPONSE_BUDGET_MS = 10_000;

/**
 * The repository URL ceiling, reused from the Repository Work rules that
 * inspect and create must follow exactly (APW-01 FR-6, spec.md:289).
 */
export const APP_REPOSITORY_URL_MAX_LENGTH = 400;

/**
 * One predicate for both doors, so inspect's URL field and create's cannot
 * drift apart. Fails closed on a non-string body arriving off the wire.
 */
export function appRepositoryUrlLengthExceeded(repositoryUrl: string): boolean {
	return typeof repositoryUrl !== 'string' || repositoryUrl.length > APP_REPOSITORY_URL_MAX_LENGTH;
}
