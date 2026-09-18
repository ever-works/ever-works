/**
 * App Works — the **App spec** itself: one hand-written interface per block of
 * `schema.md` §4–§20, the closed vocabularies those blocks use, the documented
 * defaults and the one pure predicate the rest of the programme asks this
 * package for.
 *
 * Owning epic: **APW-03** (App spec, Apps catalog and license gate).
 *
 * Spec: `docs/specs/features/app-works/APW-03-app-spec-and-catalog/schema.md` is
 * the App spec's authority — §4 (`source` is required **in `data-repository`
 * mode**), §5–§20 (one table per block, cited row by row below), §2 (the file
 * limits) and §24 (the three worked examples that must type-check). Plan:
 * `.../plan.md` §3.2 (`AppSpec` and one interface per block, `APP_SPEC_VERSION = 1`)
 * and §5.2:620 (the `default` marker's static map). Bindings:
 * `docs/specs/features/app-works/CONTRACTS.md` §1 (the App spec block outline and
 * its "Additions (APW-04)"/"Additions (APW-08)" paragraphs), §2A (:321) and
 * **R-26** — the owner's additive-only rule: nothing here is ever removed,
 * renamed or narrowed, and a union only gains members.
 *
 * **Why hand-written, when a zod schema also describes this document.** The
 * agent package's `appSpecSchema` (plan §2.2:123-125) is the runtime validator;
 * this module is the vocabulary the API, the web, the plugins and the other
 * twelve epics compile against, and it must not move every time a zod chain is
 * refactored. A type-level test in the agent package asserts the two are
 * mutually assignable (plan.md:517-518), which is what keeps them from drifting.
 *
 * **Optionality follows schema.md, not intuition.** A field is optional here
 * exactly when §5–§20 does not mark it required; several requirements are
 * conditional (`build.strategy` when `components` is non-empty, `port` for a
 * `web` component, `image` with `strategy: image`) and those conditions belong
 * to the rules of §22, where they produce a code with a position — not to the
 * type, which would then be unable to describe the document that reports the
 * problem. The same reasoning is why `source` is optional: §4:99 writes
 * "**required** (`data-repository`)", so the requirement is mode-scoped
 * (schema.md §3:89 — in `blueprint` mode `source` and `blueprint` are allowed
 * and expected, and the stand-alone schema carries no root `required: ["source"]`).
 *
 * Where the numbers live: plan §3.2 lists every constant in one block and names
 * `apps-limits.ts` as their home. That file already shipped with APW-01's
 * repository-stage and quota limits (`apps-limits.ts:39-103`, `:174-181`) and
 * this task must not edit a landed module, so the App-spec cadence and the two
 * path-list caps live here, the validator's limits live in `app-spec-issues.ts`,
 * the catalog's in `apps-catalog.types.ts` and the gate's in
 * `app-license.types.ts`. No number is declared twice.
 */

import type { AppDependencyKind } from './app-dependencies.js';
import type { LicenseClass, LicenseSource } from './app-license.types.js';

// ---------------------------------------------------------------------------
// Version and cadence (plan §3.2:465, :479-482)
// ---------------------------------------------------------------------------

/**
 * The App spec version this build understands — 1 (schema.md §1:65
 * "`spec.appSpecVersion` … 1–1000"; plan §3.2:465).
 *
 * A file declaring a **newer** version is not refused: `unknown_field` becomes
 * the warning `unknown_field_newer_version` and every other rule still applies
 * (schema.md §2:76-77). The envelope's own `version: 2` is APW-01's
 * `APP_SOURCE_SPEC_VERSION` (app-source.ts:112) and is a different number.
 */
export const APP_SPEC_VERSION = 1;

/**
 * How long two evaluations of the same App Work coalesce — 5 000 ms
 * (plan §2.3:189-192, §3.2:479; FR-22).
 *
 * A second trigger inside this window whose job has not started does not
 * dispatch a second job; the waiting job reads the newest `requestedSeq` when it
 * starts.
 */
export const APP_SPEC_EVALUATE_COALESCE_MS = 5_000;

/**
 * How long a `GET app-spec` may go without checking the tracked branch's head —
 * 60 000 ms (plan §2.3:174, §3.2:480; ACC-03-14). "At most one lazy check a
 * minute" is this number, and it is the same 60 s FR-19(a) allows a push to be
 * noticed in.
 */
export const APP_SPEC_LAZY_HEAD_CHECK_MS = 60_000;

/** How many draft validations one member may run per minute — 30 (plan §3.2:481, §4.1:548; ACC-03-08). */
export const APP_SPEC_DRAFT_VALIDATE_PER_MIN = 30;

/** How many re-checks of one App Work are accepted per minute — 6 (plan §3.2:482, §4.1:548; ACC-03-13). */
export const APP_SPEC_REFRESH_PER_MIN = 6;

/**
 * How many globs `display.protectedPaths` may hold — 50 (schema.md §8:164
 * "Glob[] … ≤ 50 entries"; plan §3.1:448). APW-08 enforces the paths: agents may
 * not change matching files (D13).
 */
export const APP_SPEC_MAX_PROTECTED_PATHS = 50;

/**
 * How many globs `agents.requireHumanMergePaths` may hold — 50
 * (schema.md §18:389 "Glob[] … ≤ 50 entries"; T1 tasks.md:64; CONTRACTS §1
 * "Additions (APW-08)":243-245).
 *
 * Those paths may be merged only by a person, whatever the merge policy says.
 * **Removals** from this list — like removals from `display.protectedPaths` —
 * are reported by `diffGuardedSpecBlocks` (CONTRACTS §2A:325); additions stay
 * allowed, so tightening is a deliberate act and loosening cannot happen
 * silently.
 */
export const APP_SPEC_MAX_REQUIRE_HUMAN_MERGE_PATHS = 50;

/**
 * The suffix under which a generated key pair's public half is exposed — the
 * literal `_PUBLIC` appended to the entry's name (schema.md §12:276, :310-311;
 * R-11). Rule R4 counts it as a second `env` name, which is why
 * `duplicate_name` fires on an entry that declares `<NAME>_PUBLIC` itself.
 */
export const APP_SPEC_PUBLIC_KEY_SUFFIX = '_PUBLIC';

// ---------------------------------------------------------------------------
// Closed vocabularies (schema.md §5–§20)
// ---------------------------------------------------------------------------

/**
 * How an App Work relates to the repository it was made from — and the only
 * values of `spec.source.relation` (schema.md §5:123 "`fork` · `private-copy` ·
 * `link`"; APW-01 owns the persisted spelling of the same three).
 *
 * The relation decides what the rest of the spec may say: `link` forbids
 * `source.upstream`, `upstreamSync` and `upstreamPullRequests.enabled: true`
 * (R13), a server-only rule compares this value with the relation recorded at
 * creation (`source_relation_mismatch`, schema.md §5:128-129), and R-4 makes a
 * fresh fork or private copy the one case the platform commits to directly.
 */
export const APP_SPEC_SOURCE_RELATIONS = ['fork', 'private-copy', 'link'] as const;

/** Union derived from {@link APP_SPEC_SOURCE_RELATIONS}. */
export type AppSpecSourceRelation = (typeof APP_SPEC_SOURCE_RELATIONS)[number];

/**
 * How the image is produced — `dockerfile`, `image`, `auto` or `none`
 * (schema.md §9:170; **R-13**, CONTRACTS.md:56; T1 tasks.md:61).
 *
 * `auto` is the zero-config build: the build plugin detects the language and
 * framework and builds without a Dockerfile, and **which** builder implements it
 * is a plugin choice that is never named in the App spec (schema.md:181-186).
 * When no enabled build plugin lists `auto`, the server-only warning
 * `build_strategy_unavailable` is reported and APW-05 refuses the Build —
 * `image` and `none` name no builder, so an empty plugin list never warns about
 * them (schema.md:504-505).
 */
export const APP_SPEC_BUILD_STRATEGIES = ['dockerfile', 'image', 'auto', 'none'] as const;

/** Union derived from {@link APP_SPEC_BUILD_STRATEGIES}. */
export type AppSpecBuildStrategy = (typeof APP_SPEC_BUILD_STRATEGIES)[number];

/** The two component roles (schema.md §10:195): `web` gets a Service and an Ingress, `worker` gets neither. */
export const APP_SPEC_COMPONENT_ROLES = ['web', 'worker'] as const;

/** Union derived from {@link APP_SPEC_COMPONENT_ROLES}. */
export type AppSpecComponentRole = (typeof APP_SPEC_COMPONENT_ROLES)[number];

/**
 * The three probes a component may declare (schema.md §10:203, :210-213).
 *
 * `readiness` defaults to `{ tcp: true }` for a `web` component, and a `worker`
 * probe may use `tcp` only with a declared port — otherwise
 * `worker_probe_without_port` (a warning), because a worker has no port by
 * definition (schema.md:212-213).
 */
export const APP_SPEC_PROBE_KINDS = ['startup', 'readiness', 'liveness'] as const;

/** Union derived from {@link APP_SPEC_PROBE_KINDS}. */
export type AppSpecProbeKind = (typeof APP_SPEC_PROBE_KINDS)[number];

/**
 * The build phase an `env` entry belongs to (schema.md §12:248;
 * `runtime` · `build` · `both`).
 *
 * Phase propagates (schema.md:447): a `runtime` entry cannot template a
 * `build`-only entry and vice versa, or the pair is `phase_mismatch`. A
 * `build.args[].fromEnv` may only name an entry that is `build` or `both`.
 */
export const APP_SPEC_ENV_PHASES = ['runtime', 'build', 'both'] as const;

/** Union derived from {@link APP_SPEC_ENV_PHASES}. */
export type AppSpecEnvPhase = (typeof APP_SPEC_ENV_PHASES)[number];

/** The five generators (schema.md §12:261): `base64` · `hex` · `chars` · `uuid` · `keypair`. */
export const APP_SPEC_GENERATE_KINDS = ['base64', 'hex', 'chars', 'uuid', 'keypair'] as const;

/** Union derived from {@link APP_SPEC_GENERATE_KINDS}. */
export type AppSpecGenerateKind = (typeof APP_SPEC_GENERATE_KINDS)[number];

/** The alphabets `generate.kind: chars` may draw from (schema.md §12:264). */
export const APP_SPEC_GENERATE_ALPHABETS = ['alnum', 'alnum-symbols', 'hex-lower', 'base64url'] as const;

/** Union derived from {@link APP_SPEC_GENERATE_ALPHABETS}. */
export type AppSpecGenerateAlphabet = (typeof APP_SPEC_GENERATE_ALPHABETS)[number];

/**
 * When a generated value is replaced (schema.md §12:266).
 *
 * `never` is the only value in `appSpecVersion: 1`: a generated value is
 * produced **once** per App Work and never regenerated unless a person
 * explicitly rotates it (CONTRACTS §1:229-230; APW-07 D9).
 */
export const APP_SPEC_GENERATE_ROTATIONS = ['never'] as const;

/** Union derived from {@link APP_SPEC_GENERATE_ROTATIONS}. */
export type AppSpecGenerateRotation = (typeof APP_SPEC_GENERATE_ROTATIONS)[number];

/** The four key-pair types (schema.md §12:272): `ed25519` · `ec-p256` · `rsa-2048` · `rsa-4096`. */
export const APP_SPEC_KEYPAIR_TYPES = ['ed25519', 'ec-p256', 'rsa-2048', 'rsa-4096'] as const;

/** Union derived from {@link APP_SPEC_KEYPAIR_TYPES}. */
export type AppSpecKeypairType = (typeof APP_SPEC_KEYPAIR_TYPES)[number];

/**
 * How a key pair's halves are stored — `pem`, `base64url-raw` or `pkcs12`
 * (schema.md §12:273; **R-11**, CONTRACTS.md:54; T1 tasks.md:61-62).
 *
 * `base64url-raw` is allowed only with `ed25519` or `ec-p256`; any other
 * combination is the error `keypair_format_unsupported` (R25, schema.md:479).
 * `pkcs12` requires `keypair.passwordEnv` naming another generated secret entry,
 * and its absence or a bad target is `keypair_password_invalid` (R26,
 * schema.md:480) — the two invalid examples of schema.md §12:303-305 exist to
 * prove both codes.
 */
export const APP_SPEC_KEYPAIR_FORMATS = ['pem', 'base64url-raw', 'pkcs12'] as const;

/** Union derived from {@link APP_SPEC_KEYPAIR_FORMATS}. */
export type AppSpecKeypairFormat = (typeof APP_SPEC_KEYPAIR_FORMATS)[number];

/**
 * When a job runs (schema.md §13:320): `pre-deploy`, `first-deploy` or
 * `post-deploy`. A `first-deploy` job runs **before** the app is exposed
 * publicly — that is what makes a bootstrap-admin job safe (CONTRACTS §1:191).
 */
export const APP_SPEC_JOB_WHENS = ['pre-deploy', 'first-deploy', 'post-deploy'] as const;

/** Union derived from {@link APP_SPEC_JOB_WHENS}. */
export type AppSpecJobWhen = (typeof APP_SPEC_JOB_WHENS)[number];

/** The methods an `http` job or cron request may use (schema.md §13:323, §14:341). */
export const APP_SPEC_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Union derived from {@link APP_SPEC_HTTP_METHODS}. */
export type AppSpecHttpMethod = (typeof APP_SPEC_HTTP_METHODS)[number];

/**
 * How `http.authEnv`'s value is sent (schema.md §13:327, a CONTRACTS §1 APW-13
 * addition): `bearer` sends `Authorization: Bearer <value>` (the default),
 * `raw` sends `Authorization: <value>` — which is what a route comparing the
 * raw header needs (CONTRACTS §1:195-199).
 */
export const APP_SPEC_HTTP_AUTH_SCHEMES = ['bearer', 'raw'] as const;

/** Union derived from {@link APP_SPEC_HTTP_AUTH_SCHEMES}. */
export type AppSpecHttpAuthScheme = (typeof APP_SPEC_HTTP_AUTH_SCHEMES)[number];

/** What Kubernetes does when a cron fire is still running (schema.md §14:343): `forbid` (default) or `allow`. */
export const APP_SPEC_CRON_CONCURRENCIES = ['forbid', 'allow'] as const;

/** Union derived from {@link APP_SPEC_CRON_CONCURRENCIES}. */
export type AppSpecCronConcurrency = (typeof APP_SPEC_CRON_CONCURRENCIES)[number];

/** What a public-domain change requires (schema.md §15:351): `restart` (default) or `rebuild`. */
export const APP_SPEC_DOMAIN_CHANGES = ['restart', 'rebuild'] as const;

/** Union derived from {@link APP_SPEC_DOMAIN_CHANGES}. */
export type AppSpecDomainChange = (typeof APP_SPEC_DOMAIN_CHANGES)[number];

/**
 * The three methods a smoke request may use (schema.md §16:361).
 *
 * `HEAD` is here and not in {@link APP_SPEC_HTTP_METHODS}: a smoke check never
 * follows redirects, so `expect.status` judges the first response
 * (CONTRACTS §1:236).
 */
export const APP_SPEC_SMOKE_HTTP_METHODS = ['GET', 'HEAD', 'POST'] as const;

/** Union derived from {@link APP_SPEC_SMOKE_HTTP_METHODS}. */
export type AppSpecSmokeHttpMethod = (typeof APP_SPEC_SMOKE_HTTP_METHODS)[number];

/** When a smoke check runs (schema.md §16:369): on every Deployment (`always`), or only on the first. */
export const APP_SPEC_SMOKE_WHENS = ['always', 'first-deploy'] as const;

/** Union derived from {@link APP_SPEC_SMOKE_WHENS}. */
export type AppSpecSmokeWhen = (typeof APP_SPEC_SMOKE_WHENS)[number];

/** The only `upstreamSync.mode` in `appSpecVersion: 1` (schema.md §19:399): `merge`. */
export const APP_SPEC_UPSTREAM_SYNC_MODES = ['merge'] as const;

/** Union derived from {@link APP_SPEC_UPSTREAM_SYNC_MODES}. */
export type AppSpecUpstreamSyncMode = (typeof APP_SPEC_UPSTREAM_SYNC_MODES)[number];

/** The Postgres majors a dependency may ask for (schema.md §11:219): `"14"` · `"15"` · `"16"` · `"17"`. */
export const APP_SPEC_POSTGRES_VERSIONS = ['14', '15', '16', '17'] as const;

/** Union derived from {@link APP_SPEC_POSTGRES_VERSIONS}. */
export type AppSpecPostgresVersion = (typeof APP_SPEC_POSTGRES_VERSIONS)[number];

/** The only Redis major in `appSpecVersion: 1` (schema.md §11:222): `"7"`. */
export const APP_SPEC_REDIS_VERSIONS = ['7'] as const;

/** Union derived from {@link APP_SPEC_REDIS_VERSIONS}. */
export type AppSpecRedisVersion = (typeof APP_SPEC_REDIS_VERSIONS)[number];

/** The Redis eviction policies (schema.md §11:223), `noeviction` first because it is the default. */
export const APP_SPEC_REDIS_MAXMEMORY_POLICIES = [
	'noeviction',
	'allkeys-lru',
	'volatile-lru',
	'allkeys-lfu',
	'volatile-lfu'
] as const;

/** Union derived from {@link APP_SPEC_REDIS_MAXMEMORY_POLICIES}. */
export type AppSpecRedisMaxmemoryPolicy = (typeof APP_SPEC_REDIS_MAXMEMORY_POLICIES)[number];

/**
 * What asked for an evaluation, spelled as the `lastEvaluationTrigger` column
 * stores it (plan §3.1:422): `created` · `push` · `pr_merged` · `manual` ·
 * `lazy` · `blueprint_applied` · `build`.
 *
 * `lazy` is the 60-second head check a `GET app-spec` performs
 * (plan §2.3:174, FR-19(a)); `build` is APW-05 asking before it refuses a Build
 * on an invalid spec.
 */
export const APP_SPEC_EVALUATION_TRIGGERS = [
	'created',
	'push',
	'pr_merged',
	'manual',
	'lazy',
	'blueprint_applied',
	'build'
] as const;

/** Union derived from {@link APP_SPEC_EVALUATION_TRIGGERS}. */
export type AppSpecEvaluationTrigger = (typeof APP_SPEC_EVALUATION_TRIGGERS)[number];

// ---------------------------------------------------------------------------
// The blocks (schema.md §5–§20, one section per interface)
// ---------------------------------------------------------------------------

/**
 * `spec.source` — where the App Work's repository came from (schema.md §5:119-129;
 * APW-01 writes it, and APW-03's apply job writes it together with the rest of
 * the spec on the Blueprint path, R-4).
 */
export interface AppSpecSource {
	/** Required. `fork` · `private-copy` · `link` (schema.md §5:123). */
	relation: AppSpecSourceRelation;
	/** Required unless `link`; **forbidden** when `link` (`upstream_forbidden_for_link`, R13). */
	upstream?: AppSpecUpstream;
	/** The Work Repository branch that is built and deployed; the Work Repository's default when absent. */
	branch?: string;
}

/**
 * `spec.source.upstream` — the repository the fork or private copy follows
 * (schema.md §5:124-125).
 */
export interface AppSpecUpstream {
	/** `owner/repo` (schema.md §5:124). */
	repo: string;
	/** The upstream's default branch at creation when absent. */
	defaultBranch?: string;
}

/**
 * `spec.blueprint` — written by the platform when an App Blueprint is applied,
 * informational afterwards (schema.md §6:131-142).
 *
 * All four fields are required; `repo` must be under `ever-works/` (otherwise
 * `blueprint_repo_outside_org`) and a server-only rule warns `blueprint_unknown`
 * for an id the Apps catalog does not list, which is what stops upgrade notices.
 */
export interface AppSpecBlueprint {
	/** `^[a-z0-9][a-z0-9-]{0,63}$`. */
	id: string;
	/** `MAJOR.MINOR.PATCH`. */
	version: string;
	/** `^ever-works/[a-z0-9-]+$`. */
	repo: string;
	/** `^[0-9a-f]{40}$` — the pinned commit. */
	sha: string;
}

/**
 * `spec.license` — **informational**: the gate classifies from detection, never
 * from this block (schema.md §7:144-157).
 *
 * A declared `spdx` or `class` that differs from detection is the warning
 * `license_declared_mismatch` (R24, a server-only rule).
 */
export interface AppSpecLicense {
	/** An SPDX expression, ≤ 200 characters (`MIT`, `MIT OR Apache-2.0`, `LicenseRef-<id>`). */
	spdx?: string;
	/** `green` · `amber` · `red` · `unknown` (schema.md §7:151). */
	class?: LicenseClass;
	/** `detected` · `blueprint` · `user` (schema.md §7:152). */
	source?: LicenseSource;
	/** Trademark / attribution notice, ≤ 500 characters. */
	notice?: string;
	/** Where network users obtain the source when the Work Repository is private (schema.md §7:154; R27). */
	sourceOfferUrl?: string;
}

/**
 * `spec.display` — how the Work presents itself (schema.md §8:159-164).
 *
 * `protectedPaths` is APW-08's D13 list: agents may not change matching files,
 * and a **removal** from this list is reported by `diffGuardedSpecBlocks`
 * (CONTRACTS §2A:325) — additions stay allowed, so a member can always tighten.
 */
export interface AppSpecDisplay {
	/** 1–80 characters; the Work's name when absent. */
	name?: string;
	/** ≤ {@link APP_SPEC_MAX_PROTECTED_PATHS} globs. */
	protectedPaths?: readonly string[];
}

/** One `build.args[]` entry — exactly one of `value` / `fromEnv` (schema.md §9:175). */
export interface AppSpecBuildArg {
	name: string;
	/** ≤ 1000 characters; never a secret (R10, `literal_secret_in_build_args`). */
	value?: string;
	/** Names an `env` entry that must be `build` or `both` (otherwise `reference_unresolved` / `phase_mismatch`). */
	fromEnv?: string;
}

/** One `env` entry of an ephemeral build service (schema.md §9:176). */
export interface AppSpecBuildServiceEnvEntry {
	name: string;
	value: string;
}

/** One ephemeral, build-only service (schema.md §9:176): at most 5, with at most 20 env entries each. */
export interface AppSpecBuildService {
	name: string;
	/** An image reference. */
	image: string;
	/** 1–65535. */
	port?: number;
	env?: readonly AppSpecBuildServiceEnvEntry[];
}

/** `build.resources` (schema.md §9:177-179) — the **build** runner's limits, not the app's. */
export interface AppSpecBuildResources {
	/** 1–16, a number (not a quantity string). */
	cpu?: number;
	/** `1Gi`–`64Gi`. */
	memory?: string;
	/** 5–180. */
	timeoutMinutes?: number;
}

/**
 * `spec.build` — how the image is produced (schema.md §9:166-186; APW-05
 * consumes it).
 *
 * `strategy` is required when `components` is non-empty and defaults to `none`
 * when it is empty (schema.md:170; R2 reports both directions as
 * `strategy_requires_components` / `components_require_strategy`). `dockerfile`,
 * `context` and `target` are meaningful with `dockerfile` only (`context` also
 * with `auto`), and `image` is required with `strategy: image`.
 */
export interface AppSpecBuild {
	/** Required when `components` is non-empty (R2). */
	strategy?: AppSpecBuildStrategy;
	/** Only with `strategy: dockerfile`; `Dockerfile` when absent. */
	dockerfile?: string;
	/** Only with `dockerfile` / `auto`; `.` when absent. */
	context?: string;
	/** `^[A-Za-z0-9._-]{1,64}$`; only with `strategy: dockerfile`. */
	target?: string;
	/** Required with `strategy: image`; a tag-only reference is the warning `image_not_pinned` (R19). */
	image?: string;
	/** ≤ 50 build-time values; never literal secrets (R10). */
	args?: readonly AppSpecBuildArg[];
	/** ≤ 5 ephemeral services, reachable only during the build. */
	services?: readonly AppSpecBuildService[];
	resources?: AppSpecBuildResources;
}

/**
 * One probe (schema.md §10:210-213; the object of `startup`, `readiness` and
 * `liveness`).
 *
 * Exactly one of `http` / `tcp` is set. The four timings are optional here
 * because the schema documents them as defaults that are never written back
 * into the file (schema.md §0; plan §2.2:124-125) — the renderer applies
 * `periodSeconds: 10`, `timeoutSeconds: 5`, `initialDelaySeconds: 0` and
 * `failureThreshold: 3` (30 for `startup`).
 */
export interface AppSpecProbe {
	/** An in-container HTTP path. */
	http?: string;
	/** A TCP connect probe. */
	tcp?: true;
	/** 1–300. */
	periodSeconds?: number;
	/** 1–60. */
	timeoutSeconds?: number;
	/** 0–600. */
	initialDelaySeconds?: number;
	/** 1–120. */
	failureThreshold?: number;
}

/** `components[].resources` (schema.md §10:204-207) — the app container's requests and limits. */
export interface AppSpecResources {
	/** Request, e.g. `250m`. */
	cpu?: string;
	/** Request, e.g. `512Mi`. */
	memory?: string;
	/** ≥ `cpu`. */
	cpuLimit?: string;
	/** ≥ `memory` (otherwise `limit_below_request`, R17). */
	memoryLimit?: string;
}

/** One `components[].volumes[]` entry (schema.md §10:208): ≤ 5, unique names **and** paths. */
export interface AppSpecVolume {
	name: string;
	/** An absolute path, ≤ 255 characters. */
	path: string;
	/** A storage quantity, e.g. `2Gi`. */
	size: string;
	/** `true` when absent — a volume is backed up unless it says otherwise. */
	backup?: boolean;
}

/**
 * One `components[]` entry (schema.md §10:188-213; APW-06 renders it).
 *
 * `port` is required for `web` and forbidden for `worker`
 * (`web_component_needs_port` / `worker_port_forbidden`, R1), a component with
 * volumes cannot run more than one replica (`volume_replicas`, R18), and
 * `runAsUser` exists for images whose `USER` is a **name**: the kubelet refuses
 * those under `runAsNonRoot` with "image has non-numeric user", so without this
 * field such an App would be undeployable on both targets with nothing the
 * author could set (schema.md:202, APW06-G26). It is passed through verbatim and
 * never derived, and omitting it renders no field at all.
 */
export interface AppSpecComponent {
	/** A DNS-label name, unique among components (R4). */
	name: string;
	role: AppSpecComponentRole;
	/** Image entrypoint override, ≤ 20 items × 1000 characters. */
	command?: readonly string[];
	/** Image cmd override, ≤ 50 items × 1000 characters. */
	args?: readonly string[];
	/** Dockerfile stage override for this component; `build.target` when absent. */
	target?: string;
	/** Required for `web` (R1), 1–65535; forbidden for `worker`. */
	port?: number;
	/** 0–10; `1` when absent. */
	replicas?: number;
	/** `false` when absent. */
	writableRootFilesystem?: boolean;
	/** 1–4294967294; the numeric uid the container must run as. Absent = the image's own user. */
	runAsUser?: number;
	probes?: {
		startup?: AppSpecProbe;
		readiness?: AppSpecProbe;
		liveness?: AppSpecProbe;
	};
	resources?: AppSpecResources;
	/** ≤ 5 volumes; a component with volumes is limited to one replica (R18). */
	volumes?: readonly AppSpecVolume[];
}

/** `dependencies.postgres` (schema.md §11:219-221). */
export interface AppSpecPostgres {
	/** `"14"` · `"15"` · `"16"` (default) · `"17"`. */
	version?: AppSpecPostgresVersion;
	/** Also provide a non-pooled URL; `deps.postgres.directUrl` needs it (R5). */
	directUrl?: boolean;
	/** ≤ 10 extensions, each `^[a-z0-9_]{1,63}$`; availability is provider-specific (`extension_unavailable`). */
	extensions?: readonly string[];
}

/** `dependencies.redis` (schema.md §11:222-224). */
export interface AppSpecRedis {
	/** `"7"` only. */
	version?: AppSpecRedisVersion;
	/** `noeviction` when absent. */
	maxmemoryPolicy?: AppSpecRedisMaxmemoryPolicy;
	/** `false` when absent. */
	persistence?: boolean;
}

/** `dependencies.objectStorage` (schema.md §11:225-226): `buckets` is required, 1–10, unique. */
export interface AppSpecObjectStorage {
	buckets: readonly string[];
	/** Must be a subset of `buckets` (otherwise `public_bucket_undeclared`, R14/§11). */
	publicBuckets?: readonly string[];
}

/** `dependencies.smtp` (schema.md §11:227): `required: true` blocks the deploy until SMTP is configured (APW-07). */
export interface AppSpecSmtp {
	required?: boolean;
}

/**
 * `spec.dependencies` — the managed services the app needs (schema.md §11:215-237;
 * APW-07 provisions them, APW-06 wires their outputs into the environment).
 *
 * The declared kinds are exactly {@link AppDependencyKind}, whose normative
 * output list is `APP_DEPENDENCY_OUTPUTS` (app-dependencies.ts:126) — the
 * `from: deps.<kind>.<output>` references of §21 resolve against it.
 */
export interface AppSpecDependencies {
	postgres?: AppSpecPostgres;
	redis?: AppSpecRedis;
	objectStorage?: AppSpecObjectStorage;
	smtp?: AppSpecSmtp;
}

/**
 * `env[].generate` (schema.md §12:257-266).
 *
 * A generated entry implies `secret: true`; `secret: false` is
 * `generated_not_secret`. `bytes` is `base64`/`hex` only, `length` and
 * `alphabet` are `chars` only, and `keypair` is `keypair` only — R9 checks that
 * `validate` agrees with the generated length, whose table is §12:308-311
 * (`hex` = 2 × bytes, `base64` = 4 × ceil(bytes / 3), `chars` = length,
 * `uuid` = 36, a `base64url-raw` key pair = 43).
 */
export interface AppSpecEnvGenerate {
	kind: AppSpecGenerateKind;
	/** 16–128; `base64` and `hex` only. */
	bytes?: number;
	/** 16–256; `chars` only. */
	length?: number;
	/** `chars` only. */
	alphabet?: AppSpecGenerateAlphabet;
	/** `keypair` only. */
	keypair?: AppSpecEnvKeypair;
	/** `never` is the only value in `appSpecVersion: 1`. */
	rotate?: AppSpecGenerateRotation;
}

/**
 * `env[].generate.keypair` (schema.md §12:268-283; **R-11**, CONTRACTS.md:54).
 *
 * The private half is the entry itself and the public half is exposed as
 * `<NAME>_PUBLIC` only — nothing else about the pair is ever exposed. See
 * {@link AppSpecKeypairFormat} for the two errors these three fields can
 * produce.
 */
export interface AppSpecEnvKeypair {
	/** `ed25519` (default) · `ec-p256` · `rsa-2048` · `rsa-4096`. */
	type?: AppSpecKeypairType;
	/** `pem` (default) · `base64url-raw` · `pkcs12`. */
	format?: AppSpecKeypairFormat;
	/** Required with `pkcs12`, forbidden otherwise (R26). */
	passwordEnv?: string;
}

/**
 * `env[].validate` (schema.md §12:254).
 *
 * `length` 1–65536, `minLength`/`maxLength` ≤ 65536 with `min ≤ max`, and
 * `pattern` ≤ 500 characters in **RE2** syntax — no back-references and no
 * look-around, or `pattern_unsupported` (the schema's own `pattern` keyword is
 * ECMA-262, which is why this cannot be left to the editor).
 */
export interface AppSpecEnvValidate {
	length?: number;
	minLength?: number;
	maxLength?: number;
	pattern?: string;
}

/** `env[].prompt` (schema.md §12:255): the question asked at setup, never a stored value (APW-01 FR-55). */
export interface AppSpecEnvPrompt {
	/** Required, 1–300 characters. */
	description: string;
	/** `true` when absent. */
	required?: boolean;
	/** ≤ 200 characters, secret-scanned — a value that matches is `prompt_example_secret`. */
	example?: string;
	/** ≤ 40 characters. */
	group?: string;
}

/**
 * One `env[]` entry (schema.md §12:239-311; APW-07 generates and stores the
 * values, APW-06 injects them).
 *
 * Exactly one value source — `value`, `from`, `template`, `generate` or
 * `prompt` — otherwise `env_source_count` (R7). `value` is forbidden on a
 * `secret: true` entry (`literal_secret_value`, R8), secrecy propagates through
 * `from`/`template` (`secret_reference_not_secret`, R6), an entry may not be
 * named `EVER_WORKS_*` (`reserved_env_name`, R23), and the implicit
 * `<NAME>_PUBLIC` of a key pair counts towards `duplicate_name` (R4).
 */
export interface AppSpecEnvEntry {
	name: string;
	/** Stored encrypted, never logged and never returned (Constitution VII). */
	secret?: boolean;
	/** `runtime` when absent. */
	phase?: AppSpecEnvPhase;
	/** ≤ 300 characters. */
	description?: string;
	/** ≤ 4096 characters; forbidden when `secret: true`. */
	value?: string;
	/** A §21 reference. */
	from?: string;
	/** ≤ 2048 characters, `{{…}}` placeholders over the same references plus `env.<NAME>`. */
	template?: string;
	/** Implies `secret: true`. */
	generate?: AppSpecEnvGenerate;
	validate?: AppSpecEnvValidate;
	prompt?: AppSpecEnvPrompt;
}

/**
 * The `http` block of a job or a cron entry (schema.md §13:323-328, §14:341).
 *
 * `path` is sent to the component's port **inside the cluster**, never through
 * the public URL, and `authEnv` must name a `secret: true` entry
 * (`auth_env_not_secret`, R15).
 */
export interface AppSpecHttpRequest {
	/** `POST` when absent. */
	method?: AppSpecHttpMethod;
	/** Required. */
	path: string;
	/** A JSON body, ≤ 16 KiB serialized; string leaves may hold `{{…}}` placeholders. */
	body?: unknown;
	/** Names a `secret: true` env entry; sent as the `Authorization` header. */
	authEnv?: string;
	/** Only with `authEnv`; `bearer` when absent. */
	authScheme?: AppSpecHttpAuthScheme;
	/** 1–10 codes, 100–599; `[200, 201, 204]` when absent. */
	expect?: { status?: readonly number[] };
}

/**
 * One `jobs[]` entry (schema.md §13:313-330; APW-06 runs it as a Kubernetes Job).
 *
 * Exactly one of `command` / `http`. `component` defaults to
 * `domains.primaryComponent` and must name a component
 * (`component_ref_unknown`, R14); an `http` job needs a `web` component
 * (`http_job_requires_web_component`).
 */
export interface AppSpecJob {
	name: string;
	when: AppSpecJobWhen;
	/** `domains.primaryComponent` when absent; the job uses that component's image and env. */
	component?: string;
	/** ≤ 20 items × 1000 characters. */
	command?: readonly string[];
	http?: AppSpecHttpRequest;
	/** 10–3600; `600` when absent. */
	timeoutSeconds?: number;
	/** 0–3; `0` when absent. */
	retries?: number;
}

/**
 * One `cron[]` entry (schema.md §14:332-343; APW-06 renders it as a cluster
 * CronJob — the app's own recurring calls, never a platform Schedule).
 *
 * `schedule` that cannot be parsed is `cron_invalid`; `component` defaults to
 * `domains.primaryComponent`; at most 20 entries, names unique.
 */
export interface AppSpecCron {
	name: string;
	schedule: string;
	/** `domains.primaryComponent` when absent. */
	component?: string;
	command?: readonly string[];
	http?: AppSpecHttpRequest;
	/** 10–3600; `300` when absent. */
	timeoutSeconds?: number;
	/** `forbid` when absent. */
	concurrency?: AppSpecCronConcurrency;
}

/**
 * `spec.domains` (schema.md §15:345-352; APW-06 renders the Ingress).
 *
 * `primaryComponent` must name a `web` component and is required with two or
 * more of them (`primary_component_invalid`, R3); `publicUrlEnv` names existing
 * `env` entries (`reference_unresolved`, R16); `onChange` says whether a domain
 * change needs a restart or a rebuild, and `needsHairpin` is for an app that
 * calls its own public URL from the server side.
 */
export interface AppSpecDomains {
	/** The only `web` component when absent. */
	primaryComponent?: string;
	/** ≤ 10 names, each an `env` entry. */
	publicUrlEnv?: readonly string[];
	/** `restart` when absent. */
	onChange?: AppSpecDomainChange;
	/** `false` when absent. */
	needsHairpin?: boolean;
}

/** The `http` block of a smoke check (schema.md §16:361-363): `GET` · `HEAD` · `POST`, body `POST` only. */
export interface AppSpecSmokeHttpRequest {
	/** `GET` when absent. */
	method?: AppSpecSmokeHttpMethod;
	/** Required. */
	path: string;
	/** ≤ 16 KiB, `POST` only. */
	body?: unknown;
}

/**
 * A smoke check's expectations (schema.md §16:365-368).
 *
 * Status codes are 1–10 entries, `bodyContains`/`bodyNotContains` are ≤ 5 × 200
 * characters, and `maxLatencyMs` is 100–60000 (10 000 when absent). A smoke
 * request never follows redirects, so these judge the first response
 * (CONTRACTS §1:236).
 */
export interface AppSpecSmokeExpect {
	/** `[200]` when absent. */
	status?: readonly number[];
	bodyContains?: readonly string[];
	bodyNotContains?: readonly string[];
	/** `10000` when absent. */
	maxLatencyMs?: number;
}

/**
 * One `smoke[]` entry (schema.md §16:354-369; APW-06 runs them after every
 * Deployment and APW-04 uses them as its gate).
 *
 * `component` defaults to `domains.primaryComponent` and must be a `web`
 * component (R14) — the check is about the app being reachable.
 */
export interface AppSpecSmoke {
	name: string;
	/** Required. */
	http: AppSpecSmokeHttpRequest;
	/** Must be `web`; `domains.primaryComponent` when absent. */
	component?: string;
	expect?: AppSpecSmokeExpect;
	/** `always` when absent. */
	when?: AppSpecSmokeWhen;
}

/**
 * One `checks[]` entry (schema.md §17:371-380; APW-08's quality gates, run
 * sandboxed in the repository's CI, R-9).
 *
 * `required: false` is the warning `advisory_check` — an advisory check verifies
 * nothing (schema.md:379).
 */
export interface AppSpecCheck {
	name: string;
	/** 1–500 characters, at least one non-whitespace character, no control characters. */
	command: string;
	/** `true` when absent. */
	required?: boolean;
	/** 60–7200; `1800` when absent. */
	timeoutSeconds?: number;
}

/**
 * `spec.agents` (schema.md §18:382-389; APW-08 owns the semantics).
 *
 * `requireHumanMergePaths` is the CONTRACTS §1 "Additions (APW-08)" key added on
 * 2026-09-17: paths whose changes **only a person may merge**, whatever the merge
 * policy says. It is ≤ {@link APP_SPEC_MAX_REQUIRE_HUMAN_MERGE_PATHS} globs and
 * defaults to `[]`, and a **removal** from it is reported by
 * `diffGuardedSpecBlocks` (CONTRACTS §2A:325) — additions stay allowed.
 */
export interface AppSpecAgents {
	/** ≤ 10 relative paths. */
	instructionFiles?: readonly string[];
	/** 50–5000; `500` when absent. */
	maxPullRequestChangedLines?: number;
	/** 1–500; `50` when absent. */
	maxPullRequestChangedFiles?: number;
	/** ≤ {@link APP_SPEC_MAX_REQUIRE_HUMAN_MERGE_PATHS} globs; `[]` when absent. */
	requireHumanMergePaths?: readonly string[];
}

/**
 * `spec.upstreamSync` (schema.md §19:391-400; APW-02 owns the sync itself).
 *
 * **Forbidden when `source.relation` is `link`**
 * (`upstream_sync_requires_upstream`, R13): a linked repository has no upstream
 * to sync from. `schedule` must fire at most once per 60 minutes, or
 * `schedule_too_frequent` (R21).
 */
export interface AppSpecUpstreamSync {
	/** `true` when absent. */
	enabled?: boolean;
	/** `0 6 * * 1` when absent. */
	schedule?: string;
	/** `merge` only. */
	mode?: AppSpecUpstreamSyncMode;
	/** `upstream.defaultBranch` when absent. */
	branch?: string;
}

/**
 * `spec.upstreamPullRequests` (schema.md §20:402-408; APW-09 owns the pull
 * requests).
 *
 * `enabled: true` requires `source.relation: fork`
 * (`upstream_prs_require_fork`, R13), and `requireApproval` can only be `true` —
 * a person always approves (R12, `upstream_pr_approval_required`).
 */
export interface AppSpecUpstreamPullRequests {
	/** `false` when absent. */
	enabled?: boolean;
	/** Only `true` is valid. */
	requireApproval?: boolean;
	/** 1–10; `3` when absent. */
	maxOpen?: number;
}

/**
 * `spec.provisioning` — the CONTRACTS §1 "Additions (APW-04)" key
 * (CONTRACTS.md:238-241; schema.md §20:410-414).
 *
 * The owner's opt-in to automatic re-provisioning when an Upstream sync breaks
 * the smoke tests. The App Provisioner never writes this block and treats it as
 * a preserved field, like `source`, `blueprint`, `license`,
 * `display.protectedPaths`, `upstreamSync` and `upstreamPullRequests`.
 */
export interface AppSpecProvisioning {
	/** `false` when absent. */
	autoReprovision?: boolean;
}

/**
 * The App spec — the `spec` block of `.works/works.yml` when `kind: app`
 * (schema.md §4:95-117; FR-1).
 *
 * `kind` and `appSpecVersion` are the two envelope keys the spec accepts
 * (schema.md §1:63-65): `spec.kind` must equal the root kind when both are
 * present (`kind_mismatch`), and a newer `appSpecVersion` downgrades
 * `unknown_field` to a warning. Every other key is a block of §5–§20, `x-*` keys
 * are allowed at any depth and ignored (schema.md §2:74-75), and a key this type
 * does not define is itself the error `unknown_field`.
 *
 * `source` is optional **because the requirement is mode-scoped** — see this
 * module's header: schema.md §4:99 marks it required for `data-repository` mode
 * only, and §3:89 allows (and expects) it in `blueprint` mode. The `data-repository`
 * requirement is reported as an issue by the validator, not enforced by the type.
 */
export interface AppSpec {
	/** Optional; repeats the root `kind` and must equal it when both are present. */
	kind?: 'app';
	/** Optional; 1–1000, default 1. A newer value downgrades `unknown_field` to a warning. */
	appSpecVersion?: number;
	/** Required in `data-repository` mode (schema.md §4:99); allowed in `blueprint` mode (§3:89). */
	source?: AppSpecSource;
	blueprint?: AppSpecBlueprint;
	license?: AppSpecLicense;
	display?: AppSpecDisplay;
	/** Required when `components` is non-empty (R2). */
	build?: AppSpecBuild;
	/** ≤ 10; at least one when `build.strategy` ≠ `none` (`strategy_requires_components`, R2). */
	components?: readonly AppSpecComponent[];
	dependencies?: AppSpecDependencies;
	/** ≤ 200 entries, names unique. */
	env?: readonly AppSpecEnvEntry[];
	/** ≤ 10 entries, names unique. */
	jobs?: readonly AppSpecJob[];
	/** ≤ 20 entries, names unique. */
	cron?: readonly AppSpecCron[];
	domains?: AppSpecDomains;
	/** ≤ 20 entries, names unique. */
	smoke?: readonly AppSpecSmoke[];
	/** ≤ 20 entries, names unique. */
	checks?: readonly AppSpecCheck[];
	agents?: AppSpecAgents;
	upstreamSync?: AppSpecUpstreamSync;
	upstreamPullRequests?: AppSpecUpstreamPullRequests;
	provisioning?: AppSpecProvisioning;
}

// ---------------------------------------------------------------------------
// The `default` marker's map (plan §5.2:620)
// ---------------------------------------------------------------------------

/**
 * The documented default of every App-spec field that has a **literal** one,
 * keyed by its path, for the App spec tab's `default` marker
 * (plan §5.2:620 — "`default` marker from a static defaults map exported by
 * `app-spec.types.ts`"; schema.md §0: defaults are documented and never written
 * back into the file).
 *
 * Only literals are here. The defaults that are **relative** stay out and are
 * named in the block comments instead, because no value would be honest:
 * `build.strategy` is `none` only while `components` is empty,
 * `components[].target` is `build.target`, `resources.memoryLimit` is `2 × memory`,
 * `components[].command`/`args` are the image's entrypoint and cmd,
 * `components[].runAsUser` is the image's own user, `source.branch` and
 * `upstreamSync.branch` are the Work Repository's and the upstream's default
 * branch, `jobs[].component`/`cron[].component`/`smoke[].component`/
 * `domains.primaryComponent` resolve against the declared components, and
 * `components[].probes.readiness` is `{ tcp: true }` for `web` only.
 *
 * Every key names the schema.md row it comes from; a value is a scalar or an
 * array of scalars, so the web can render it without a cast.
 */
export const APP_SPEC_BLOCK_DEFAULTS: Readonly<
	Record<string, string | number | boolean | readonly (string | number)[]>
> = {
	// §8 display
	'display.protectedPaths': [],
	// §9 build
	'build.dockerfile': 'Dockerfile',
	'build.context': '.',
	'build.args': [],
	'build.services': [],
	'build.resources.cpu': 2,
	'build.resources.memory': '7Gi',
	'build.resources.timeoutMinutes': 60,
	// §10 components
	'components[].replicas': 1,
	'components[].writableRootFilesystem': false,
	'components[].probes.startup.periodSeconds': 10,
	'components[].probes.startup.timeoutSeconds': 5,
	'components[].probes.startup.initialDelaySeconds': 0,
	'components[].probes.startup.failureThreshold': 30,
	'components[].probes.readiness.periodSeconds': 10,
	'components[].probes.readiness.timeoutSeconds': 5,
	'components[].probes.readiness.initialDelaySeconds': 0,
	'components[].probes.readiness.failureThreshold': 3,
	'components[].probes.liveness.periodSeconds': 10,
	'components[].probes.liveness.timeoutSeconds': 5,
	'components[].probes.liveness.initialDelaySeconds': 0,
	'components[].probes.liveness.failureThreshold': 3,
	'components[].resources.cpu': '250m',
	'components[].resources.memory': '512Mi',
	'components[].volumes': [],
	'components[].volumes[].backup': true,
	// §11 dependencies
	'dependencies.postgres.version': '16',
	'dependencies.postgres.directUrl': false,
	'dependencies.postgres.extensions': [],
	'dependencies.redis.version': '7',
	'dependencies.redis.maxmemoryPolicy': 'noeviction',
	'dependencies.redis.persistence': false,
	'dependencies.objectStorage.publicBuckets': [],
	'dependencies.smtp.required': false,
	// §12 env
	'env[].secret': false,
	'env[].phase': 'runtime',
	'env[].generate.bytes': 32,
	'env[].generate.length': 32,
	'env[].generate.alphabet': 'alnum',
	'env[].generate.keypair.type': 'ed25519',
	'env[].generate.keypair.format': 'pem',
	'env[].generate.rotate': 'never',
	'env[].prompt.required': true,
	// §13 jobs
	'jobs[].http.method': 'POST',
	'jobs[].http.authScheme': 'bearer',
	'jobs[].http.expect.status': [200, 201, 204],
	'jobs[].timeoutSeconds': 600,
	'jobs[].retries': 0,
	// §14 cron
	'cron[].http.method': 'POST',
	'cron[].http.authScheme': 'bearer',
	'cron[].http.expect.status': [200, 201, 204],
	'cron[].timeoutSeconds': 300,
	'cron[].concurrency': 'forbid',
	// §15 domains
	'domains.publicUrlEnv': [],
	'domains.onChange': 'restart',
	'domains.needsHairpin': false,
	// §16 smoke
	'smoke[].http.method': 'GET',
	'smoke[].expect.status': [200],
	'smoke[].expect.bodyContains': [],
	'smoke[].expect.bodyNotContains': [],
	'smoke[].expect.maxLatencyMs': 10000,
	'smoke[].when': 'always',
	// §17 checks
	'checks[].required': true,
	'checks[].timeoutSeconds': 1800,
	// §18 agents
	'agents.instructionFiles': [],
	'agents.maxPullRequestChangedLines': 500,
	'agents.maxPullRequestChangedFiles': 50,
	'agents.requireHumanMergePaths': [],
	// §19 upstreamSync
	'upstreamSync.enabled': true,
	'upstreamSync.schedule': '0 6 * * 1',
	'upstreamSync.mode': 'merge',
	// §20 upstreamPullRequests, provisioning
	'upstreamPullRequests.enabled': false,
	'upstreamPullRequests.requireApproval': true,
	'upstreamPullRequests.maxOpen': 3,
	'provisioning.autoReprovision': false
};

// ---------------------------------------------------------------------------
// The source-only predicate (T12 tasks.md:276-285; R-4 CONTRACTS.md:47)
// ---------------------------------------------------------------------------

/**
 * The prefix that marks an extension key (schema.md §2:74-75): allowed at any
 * depth inside `spec`, preserved, and ignored — including by
 * {@link isSourceOnlyAppSpec}, which is why a file carrying only `source` and an
 * `x-` note is still source-only.
 */
export const APP_SPEC_EXTENSION_KEY_PREFIX = 'x-';

/**
 * The three keys a spec may hold and still count as **source only**
 * (T12 tasks.md:276-285; R-4 CONTRACTS.md:47 "whose spec holds only `source`").
 *
 * `kind` and `appSpecVersion` are the envelope keys schema.md §1:63-65 adds to
 * the block; `source` is the one block APW-01 writes at creation. Every other
 * key means somebody — a person, a Blueprint or the App Provisioner — has
 * already said something about how the app is built or run.
 */
export const APP_SPEC_SOURCE_ONLY_KEYS = ['kind', 'appSpecVersion', 'source'] as const;

/** Union derived from {@link APP_SPEC_SOURCE_ONLY_KEYS}. */
export type AppSpecSourceOnlyKey = (typeof APP_SPEC_SOURCE_ONLY_KEYS)[number];

/**
 * Whether a `spec` block holds nothing but `source` (plus the two envelope keys
 * and any `x-` extension key) — the pure helper T12's `hasValidAppSpec` and
 * APW-03's apply job both consume (tasks.md:276-285).
 *
 * **Why it exists.** R2 requires `build`/`components` only when one of them is
 * present, so the minimal file APW-01 writes for a fresh fork
 * (`{ version, kind, spec.source }`) validates with zero errors. Without this
 * predicate that file would read as a *valid* App spec, the App Provisioner
 * would never start, and APW-01 FR-29a could not hold. `false` here means "this
 * spec says something about the app"; `true` means "only where it came from".
 *
 * `true` for `{}` and for `{ source }`; `false` as soon as one key outside
 * {@link APP_SPEC_SOURCE_ONLY_KEYS} appears. A non-object — `null`, a string, an
 * array — is **`false`**: nothing may read an unparseable value as the fresh,
 * source-only path (R-4's one direct commit). `x-` keys are ignored at the top
 * level and, because only the top-level key set is inspected, `x-` keys nested
 * inside `source` are ignored too, exactly as schema.md §2:74-75 says.
 */
export function isSourceOnlyAppSpec(spec: unknown): boolean {
	if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
		return false;
	}

	const allowed: readonly string[] = APP_SPEC_SOURCE_ONLY_KEYS;
	for (const key of Object.keys(spec)) {
		if (key.startsWith(APP_SPEC_EXTENSION_KEY_PREFIX)) {
			continue;
		}
		if (!allowed.includes(key)) {
			return false;
		}
	}

	return true;
}
