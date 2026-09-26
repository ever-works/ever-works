/**
 * T3 — the `Work` CRD (APW-10 plan §3.1:223–294, tasks T3; ACC-10-26, ACC-10-27).
 *
 * `Work` is the whole tier contract: the platform writes **desired state only** (Resolution R-5)
 * and the zone controller renders, applies and reports. Every field below is the field of
 * `AppsTierWorkSpec` / `AppsTierWorkStatus` in `packages/contracts/src/apps/apps-tier.ts` — the
 * landed, T1-owned wire model — and the mapping is enforced by the compiler, not by review:
 *
 * - `WORK_SPEC_PROPERTIES: Record<keyof AppsTierWorkSpec, JsonSchema>` fails to compile if a
 *   contract member has no schema here or if a schema member is invented — the annotation checks
 *   both directions, and it is an annotation rather than `satisfies` so the nested `type:` fields
 *   keep the schema's own union instead of widening to `string`;
 * - `WORK_SPEC_REQUIRED` is checked in both directions against the contract's non-optional members
 *   (`RequiredKeys` below), so a field cannot be silently made optional in one artefact only.
 *
 * ## What a CRD can and cannot refuse (APW10-G21)
 *
 * ACC-10-26 and ACC-10-27 name four refusals. Three of them are properties of this schema and are
 * observable here: an unknown field under `spec` (`namespace` among them — `spec` is closed), an
 * image that is not digest-pinned, and every FR-26 count/byte bound, which is expressed as
 * `maxItems` / `maxLength` / `maxProperties` / `maximum` rather than as one whole-object size rule.
 * The whole-object 512 KiB rule is **not** expressible in a structural schema — the plan says so
 * itself (APW10-G21, plan §3.1:272 moves the claim to per-field bounds) — so it lives in
 * `object-size.ts`, called by T5's `work-spec.validator.ts`, and the refusal *codes* the owner
 * sees (`NAMESPACE_FIELD_FORBIDDEN`, `SPEC_LIMIT_EXCEEDED`, …) are T5's, not the CRD's.
 */
import type {
	AppsTierComponent,
	AppsTierComponentStatus,
	AppsTierComponentVolume,
	AppsTierCron,
	AppsTierDependencyRef,
	AppsTierDependencyStatusView,
	AppsTierHost,
	AppsTierImage,
	AppsTierJob,
	AppsTierJobStatusView,
	AppsTierPromotion,
	AppsTierProbe,
	AppsTierQuarantineStatus,
	AppsTierRemovalStatus,
	AppsTierSealedEnv,
	AppsTierSmoke,
	AppsTierSmokeStatusView,
	AppsTierWorkRefusal,
	AppsTierWorkSpec,
	AppsTierWorkStatus
} from '@ever-works/contracts';
import {
	APPS_TIER_COMPONENT_ROLES,
	APPS_TIER_DEPLOY_PHASES,
	APPS_TIER_DEPENDENCY_PHASES,
	APPS_TIER_JOB_PHASES,
	APPS_TIER_JOB_STATUSES,
	APPS_TIER_MAX_COMPONENT_REPLICAS,
	APPS_TIER_MAX_COMPONENT_VOLUMES,
	APPS_TIER_MAX_COMPONENTS,
	APPS_TIER_MAX_CRON,
	APPS_TIER_MAX_ENV_NAMES,
	APPS_TIER_MAX_HOSTS,
	APPS_TIER_MAX_IMAGES,
	APPS_TIER_MAX_JOBS,
	APPS_TIER_MAX_JOB_TIMEOUT_SECONDS,
	APPS_TIER_MAX_PULL_CREDENTIAL_BYTES,
	APPS_TIER_MAX_SEALED_ENV_BYTES,
	APPS_TIER_MAX_SMOKE,
	APPS_TIER_QUARANTINE_CATEGORIES,
	APPS_TIER_SMOKE_SCOPES,
	APPS_TIER_SMOKE_STATUSES,
	APPS_TIER_WORK_DESIRED_STATES,
	APPS_TIER_WORK_PHASES,
	APPS_TIER_WORK_REFUSAL_CODES,
	APP_DEPENDENCY_KINDS,
	APP_HTTP_AUTH_SCHEMES,
	APP_VERIFICATION_PROBE_KINDS
} from '@ever-works/contracts';

import type { CrdDefinition, CustomResourceDefinitionManifest, JsonSchema } from './crd.js';
import { customResourceDefinition, rootSchema } from './crd.js';
import {
	arrayOf,
	base64EncodedLength,
	closedObject,
	DIGEST_PINNED_IMAGE_PATTERN,
	integerSchema,
	nullable,
	nullableStringSchema,
	numberSchema,
	stringArraySchema,
	stringSchema,
	TENANT_NAMESPACE_PATTERN,
	UUID_PATTERN
} from './json-schema.js';

/** The members of an interface that are **not** optional — used to pin `required` to the contract. */
type RequiredKeys<T> = { [K in keyof T]-?: undefined extends T[K] ? never : K }[keyof T];

/** Compiles only for `never`; the assertion vehicle for the required-key checks below. */
type AssertNever<T extends never> = T;

/**
 * A health probe on a component — `AppsTierProbe` (plan §3.1:245–247).
 *
 * The plan names the three probe slots but not their inner shape; the contract does, and it is
 * mirrored here rather than guessed. `probes` is what `kind` exists for: an `http` probe carries a
 * `path`, a `tcp` probe a `port`, and the CRD cannot express that correlation without `oneOf`,
 * which a structural schema forbids — so the pairing is T5's rule and the two fields are declared
 * side by side here.
 */
const PROBE_PROPERTIES: Record<keyof AppsTierProbe, JsonSchema> = {
	kind: {
		type: 'string',
		enum: APP_VERIFICATION_PROBE_KINDS,
		description: 'Probe kind (`http` or `tcp`) — plan §3.1:245.'
	},
	path: stringSchema({ description: 'HTTP path, for an `http` probe.', maxLength: 1_024 }),
	port: integerSchema({ description: 'TCP port, for a `tcp` probe.', minimum: 1, maximum: 65_535 }),
	failureThreshold: integerSchema({ description: 'Consecutive failures that fail the probe.', minimum: 1 }),
	periodSeconds: integerSchema({ description: 'Seconds between attempts.', minimum: 1 })
};

/** The probe slots a component may declare (plan §3.1:245). */
const COMPONENT_PROBES_PROPERTIES: Record<keyof AppsTierComponent['probes'], JsonSchema> = {
	startup: closedObject(PROBE_PROPERTIES, { description: 'Startup probe.' }),
	readiness: closedObject(PROBE_PROPERTIES, { description: 'Readiness probe.' }),
	liveness: closedObject(PROBE_PROPERTIES, { description: 'Liveness probe.' })
};

/** A component's declared volume — `AppsTierComponentVolume` (plan §3.1:247). */
const COMPONENT_VOLUME_PROPERTIES: Record<keyof AppsTierComponentVolume, JsonSchema> = {
	name: stringSchema({ description: 'Volume name.', minLength: 1, maxLength: 63 }),
	path: stringSchema({ description: 'Mount path.', minLength: 1, maxLength: 1_024 }),
	size: stringSchema({
		description: 'Requested size (a Kubernetes quantity, e.g. `1Gi`).',
		minLength: 2,
		maxLength: 16
	})
};

/** A component's resource request/limits — `AppsTierComponent['resources']` (plan §3.1:246). */
const COMPONENT_RESOURCES_PROPERTIES: Record<keyof AppsTierComponent['resources'], JsonSchema> = {
	cpu: stringSchema({ description: 'CPU request (e.g. `50m`).', minLength: 1, maxLength: 16 }),
	memory: stringSchema({ description: 'Memory request (e.g. `64Mi`).', minLength: 2, maxLength: 16 }),
	memoryLimit: stringSchema({ description: 'Memory limit (e.g. `128Mi`).', minLength: 2, maxLength: 16 })
};

/** One component of the desired state — `AppsTierComponent` (plan §3.1:245–247). */
const COMPONENT_PROPERTIES: Record<keyof AppsTierComponent, JsonSchema> = {
	name: stringSchema({ description: 'Component name, unique inside the Work.', minLength: 1, maxLength: 63 }),
	role: { type: 'string', enum: APPS_TIER_COMPONENT_ROLES, description: '`web` or `worker` — plan §3.1:245.' },
	command: stringArraySchema({ description: 'Container command (`argv`).', maxItems: 64 }),
	args: stringArraySchema({ description: 'Container arguments.', maxItems: 64 }),
	port: integerSchema({ description: 'Container port.', minimum: 1, maximum: 65_535 }),
	replicas: integerSchema({
		description: `Replicas, at most ${APPS_TIER_MAX_COMPONENT_REPLICAS} — plan §3.1:245.`,
		minimum: 0,
		maximum: APPS_TIER_MAX_COMPONENT_REPLICAS
	}),
	resources: closedObject(COMPONENT_RESOURCES_PROPERTIES, { description: 'Resource requests and limits.' }),
	probes: closedObject(COMPONENT_PROBES_PROPERTIES, { description: 'The three probe slots — plan §3.1:245.' }),
	volumes: arrayOf(closedObject(COMPONENT_VOLUME_PROPERTIES), {
		description: `Volumes, at most ${APPS_TIER_MAX_COMPONENT_VOLUMES} per component — spec FR-26:295.`,
		maxItems: APPS_TIER_MAX_COMPONENT_VOLUMES
	}),
	writableRootFilesystem: {
		type: 'boolean',
		description: 'Whether the component needs a writable root filesystem — plan §3.1:247.'
	}
};

/** The members `AppsTierComponent` declares as required. */
const COMPONENT_REQUIRED = [
	'name',
	'role',
	'command',
	'args',
	'port',
	'replicas',
	'resources',
	'probes',
	'volumes',
	'writableRootFilesystem'
] as const satisfies readonly (keyof AppsTierComponent)[];

/** One manifest job — `AppsTierJob` (plan §3.1:248). */
const JOB_PROPERTIES: Record<keyof AppsTierJob, JsonSchema> = {
	name: stringSchema({ description: 'Job name.', minLength: 1, maxLength: 63 }),
	when: {
		type: 'string',
		enum: APPS_TIER_JOB_PHASES,
		description: '`pre-deploy` | `first-deploy` | `post-deploy`.'
	},
	component: stringSchema({ description: 'The component the job runs against.', minLength: 1, maxLength: 63 }),
	command: stringArraySchema({ description: 'In-pod command (`argv`).', maxItems: 64 }),
	http: closedObject(
		{
			method: stringSchema({ description: 'HTTP method.', minLength: 1, maxLength: 10 }),
			path: stringSchema({ description: 'HTTP path.', minLength: 1, maxLength: 1_024 }),
			body: stringSchema({ description: 'Request body.', maxLength: 65_536 }),
			authEnv: stringSchema({ description: 'Environment variable holding the credential.', maxLength: 253 }),
			authScheme: {
				type: 'string',
				enum: APP_HTTP_AUTH_SCHEMES,
				description: '`bearer` or `raw` — CONTRACTS C2, plan §3.1:249.'
			}
		},
		{
			description:
				'The job’s HTTP form. Exactly one of `command` / `http` is required — a rule a structural schema cannot state (no `oneOf`), so T5 enforces it.',
			required: ['method', 'path', 'authScheme']
		}
	),
	timeoutSeconds: integerSchema({
		description: `Timeout, at most ${APPS_TIER_MAX_JOB_TIMEOUT_SECONDS} s — plan §3.1:248.`,
		minimum: 1,
		maximum: APPS_TIER_MAX_JOB_TIMEOUT_SECONDS
	})
};

/** The members `AppsTierJob` declares as required. */
const JOB_REQUIRED = ['name', 'when', 'component', 'timeoutSeconds'] as const satisfies readonly (keyof AppsTierJob)[];

/** One schedule — `AppsTierCron` (plan §3.1:249). */
const CRON_PROPERTIES: Record<keyof AppsTierCron, JsonSchema> = {
	name: stringSchema({ description: 'Schedule name.', minLength: 1, maxLength: 63 }),
	schedule: stringSchema({
		description:
			'A cron expression. The plan requires intervals of at least 5 minutes (plan §3.1:249); the interval itself is T5’s `CRON_TOO_FREQUENT` rule, since a structural schema cannot measure a schedule.',
		minLength: 9,
		maxLength: 128
	}),
	http: closedObject(
		{
			method: stringSchema({ description: 'HTTP method.', minLength: 1, maxLength: 10 }),
			path: stringSchema({ description: 'HTTP path.', minLength: 1, maxLength: 1_024 }),
			authEnv: stringSchema({ description: 'Environment variable holding the credential.', maxLength: 253 }),
			authScheme: {
				type: 'string',
				enum: APP_HTTP_AUTH_SCHEMES,
				description: '`bearer` or `raw` — CONTRACTS C2.'
			}
		},
		{ description: 'What the schedule calls.', required: ['method', 'path', 'authEnv', 'authScheme'] }
	)
};

/** A declared smoke check — `AppsTierSmoke` (plan §3.1:250). */
const SMOKE_PROPERTIES: Record<keyof AppsTierSmoke, JsonSchema> = {
	name: stringSchema({ description: 'Smoke check name.', minLength: 1, maxLength: 63 }),
	component: stringSchema({ description: 'The component the check targets.', minLength: 1, maxLength: 63 }),
	path: stringSchema({ description: 'HTTP path.', minLength: 1, maxLength: 1_024 }),
	method: stringSchema({ description: 'HTTP method.', minLength: 1, maxLength: 10 }),
	expect: closedObject(
		{
			status: {
				type: 'array',
				description: 'Accepted HTTP status codes.',
				minItems: 1,
				items: integerSchema({ minimum: 100, maximum: 599 })
			},
			bodyContains: stringArraySchema({ description: 'Substrings the body must contain.', maxItems: 64 }),
			bodyNotContains: stringArraySchema({ description: 'Substrings the body must not contain.', maxItems: 64 })
		},
		{ description: 'What a passing response looks like.', required: ['status', 'bodyContains', 'bodyNotContains'] }
	),
	latencyMs: numberSchema({ description: 'Latency budget in milliseconds.', minimum: 0 }),
	firstDeployOnly: { type: 'boolean', description: 'Run the check on the first deploy only.' }
};

/** The members `AppsTierSmoke` declares as required. */
const SMOKE_REQUIRED = [
	'name',
	'component',
	'path',
	'method',
	'expect',
	'latencyMs',
	'firstDeployOnly'
] as const satisfies readonly (keyof AppsTierSmoke)[];

/** A published host — `AppsTierHost` (plan §3.1:251). */
const HOST_PROPERTIES: Record<keyof AppsTierHost, JsonSchema> = {
	host: stringSchema({ description: 'The hostname.', minLength: 1, maxLength: 253 }),
	kind: { type: 'string', enum: ['managed', 'custom'], description: '`managed` (zone subdomain) or `custom`.' },
	customHostnameRef: nullable(
		stringSchema({
			description:
				'The custom hostname record, for `kind: custom`. Nullable because the platform writes an explicit `null` for a managed host (APW-13’s golden `work.yaml`).',
			maxLength: 64
		})
	)
};

/** A digest-pinned image with an optional single-use pull credential (plan §3.1:241–244). */
const IMAGE_PROPERTIES: Record<keyof AppsTierImage, JsonSchema> = {
	component: stringSchema({ description: 'The component the image runs.', minLength: 1, maxLength: 63 }),
	source: stringSchema({
		description: '`<registry>/<owner>/<repo>@sha256:<64 hex>` — plan §3.1:243.',
		pattern: DIGEST_PINNED_IMAGE_PATTERN,
		maxLength: 512
	}),
	pullCredential: closedObject(
		{
			sealed: stringSchema({
				description: `The sealed credential, base64 (≤ ${APPS_TIER_MAX_PULL_CREDENTIAL_BYTES} bytes) — plan §3.1:244.`,
				minLength: 1,
				maxLength: base64EncodedLength(APPS_TIER_MAX_PULL_CREDENTIAL_BYTES)
			}),
			expiresAt: stringSchema({
				description: 'When the single-use credential expires (≤ 15 min after issue) — spec FR-32:319–320.',
				minLength: 20,
				maxLength: 40
			})
		},
		{
			description: 'A single-use pull credential, sealed to the controller key.',
			required: ['sealed', 'expiresAt']
		}
	)
};

/** The sealed environment (plan §3.1:252, spec FR-26:294–297). */
const SEALED_ENV_PROPERTIES: Record<keyof AppsTierSealedEnv, JsonSchema> = {
	sealed: stringSchema({
		description: `The sealed environment, base64 (≤ ${APPS_TIER_MAX_SEALED_ENV_BYTES} bytes = 256 KiB).`,
		minLength: 1,
		maxLength: base64EncodedLength(APPS_TIER_MAX_SEALED_ENV_BYTES)
	}),
	names: stringArraySchema({
		description: `Variable names, at most ${APPS_TIER_MAX_ENV_NAMES} — spec FR-26:295.`,
		maxItems: APPS_TIER_MAX_ENV_NAMES,
		itemDescription: 'An environment variable name.'
	})
};

/** A dependency reference resolved inside the zone (plan §3.1:253, CONTRACTS §3). */
const DEPENDENCY_PROPERTIES: Record<keyof AppsTierDependencyRef, JsonSchema> = {
	kind: {
		type: 'string',
		enum: APP_DEPENDENCY_KINDS,
		description: '`postgres` | `redis` | `objectStorage` | `smtp`.'
	},
	ref: stringSchema({
		description: 'The zone-side dependency reference (`dep-<kind>`) — APW-07.',
		minLength: 1,
		maxLength: 128
	})
};

/** `Work.spec` — every member of `AppsTierWorkSpec`, and nothing else (plan §3.1:230–253). */
const WORK_SPEC_PROPERTIES: Record<keyof AppsTierWorkSpec, JsonSchema> = {
	workId: stringSchema({ description: 'The Work id — immutable (plan §3.1:231).', pattern: UUID_PATTERN }),
	ownerUserId: stringSchema({ description: 'The owning user (plan §3.1:232).', pattern: UUID_PATTERN }),
	organizationId: nullable(
		stringSchema({
			description: 'The owning organisation, when the Work belongs to one (plan §3.1:233).',
			pattern: UUID_PATTERN
		})
	),
	generation: integerSchema({
		description: 'The platform deploy generation — monotonically increasing (plan §3.1:234).',
		minimum: 1
	}),
	quotaProfile: stringSchema({
		description:
			'The quota profile name; it must exist in zone config, which is why this is not an enum — an unknown name is refused `QUOTA_PROFILE_UNKNOWN` (plan §3.1:235, :274).',
		minLength: 1,
		maxLength: 32
	}),
	desiredState: {
		type: 'string',
		enum: APPS_TIER_WORK_DESIRED_STATES,
		description:
			'`running` | `paused` | `quarantined` | `removed`. `removed` is a removal under R-15 and keeps data unless `dataDeletion` is set (plan §3.1:236, §2.6).'
	},
	pausedReplicas: nullable({
		type: 'object',
		description:
			'Replica counts recorded by the platform when it paused the Work, restored on resume (plan §3.1:237).',
		maxProperties: APPS_TIER_MAX_COMPONENTS,
		additionalProperties: integerSchema({ minimum: 0, maximum: APPS_TIER_MAX_COMPONENT_REPLICAS })
	}),
	dataDeletion: nullable(
		closedObject(
			{
				requestedAt: stringSchema({
					description: 'When the owner confirmed the data deletion.',
					minLength: 20,
					maxLength: 40
				}),
				requestedByUserId: stringSchema({ description: 'Who confirmed it.', pattern: UUID_PATTERN })
			},
			{ required: ['requestedAt', 'requestedByUserId'] }
		)
	),
	quarantine: nullable(
		closedObject(
			{
				requestId: stringSchema({
					description: 'The quarantine request the platform opened.',
					pattern: UUID_PATTERN
				}),
				category: {
					type: 'string',
					enum: APPS_TIER_QUARANTINE_CATEGORIES,
					description: 'Owner-safe category — plan §3.1:239.'
				},
				requestedAt: stringSchema({ description: 'When it was requested.', minLength: 20, maxLength: 40 })
			},
			{
				description: 'The quarantine the zone is asked to sequence (plan §3.1:239).',
				required: ['requestId', 'category', 'requestedAt']
			}
		)
	),
	egressThrottle: { type: 'boolean', description: 'The 100 % egress-throttle state — spec FR-36 (plan §3.1:240).' },
	images: arrayOf(closedObject(IMAGE_PROPERTIES), {
		description: `Digest-pinned images, at most ${APPS_TIER_MAX_IMAGES} — plan §3.1:241.`,
		maxItems: APPS_TIER_MAX_IMAGES
	}),
	components: arrayOf(closedObject(COMPONENT_PROPERTIES, { required: COMPONENT_REQUIRED }), {
		description: `Components, at most ${APPS_TIER_MAX_COMPONENTS} — spec FR-26:294.`,
		maxItems: APPS_TIER_MAX_COMPONENTS
	}),
	jobs: arrayOf(closedObject(JOB_PROPERTIES, { required: JOB_REQUIRED }), {
		description: `Manifest jobs, at most ${APPS_TIER_MAX_JOBS} — spec FR-26:294.`,
		maxItems: APPS_TIER_MAX_JOBS
	}),
	cron: arrayOf(closedObject(CRON_PROPERTIES), {
		description: `Schedules, at most ${APPS_TIER_MAX_CRON} — spec FR-26:295.`,
		maxItems: APPS_TIER_MAX_CRON
	}),
	smoke: arrayOf(closedObject(SMOKE_PROPERTIES, { required: SMOKE_REQUIRED }), {
		description: `Smoke checks, at most ${APPS_TIER_MAX_SMOKE} — spec FR-26:295.`,
		maxItems: APPS_TIER_MAX_SMOKE
	}),
	hosts: arrayOf(closedObject(HOST_PROPERTIES), {
		description: `Published hosts, at most ${APPS_TIER_MAX_HOSTS} — spec FR-26:295.`,
		maxItems: APPS_TIER_MAX_HOSTS
	}),
	env: closedObject(SEALED_ENV_PROPERTIES, {
		description: 'The sealed environment (plan §3.1:252).',
		required: ['sealed', 'names']
	}),
	dependencies: arrayOf(closedObject(DEPENDENCY_PROPERTIES), {
		description:
			'Dependency references, resolved in the zone (plan §3.1:253). Deliberately uncapped: no FR-26 limit covers them, so no ceiling is invented here.'
	})
};

/** The members `AppsTierWorkSpec` declares as required — a `Work` carries its whole desired state. */
const WORK_SPEC_REQUIRED = [
	'workId',
	'ownerUserId',
	'organizationId',
	'generation',
	'quotaProfile',
	'desiredState',
	'pausedReplicas',
	'dataDeletion',
	'quarantine',
	'egressThrottle',
	'images',
	'components',
	'jobs',
	'cron',
	'smoke',
	'hosts',
	'env',
	'dependencies'
] as const satisfies readonly (keyof AppsTierWorkSpec)[];

/**
 * Every non-optional contract member is required by the CRD, and the CRD requires nothing the
 * contract does not declare. Both halves are compile-time: `AssertNever` only accepts `never`.
 */
type _WorkSpecRequiredCovered = AssertNever<
	Exclude<RequiredKeys<AppsTierWorkSpec>, (typeof WORK_SPEC_REQUIRED)[number]>
>;
type _WorkSpecRequiredDeclared = AssertNever<
	Exclude<(typeof WORK_SPEC_REQUIRED)[number], RequiredKeys<AppsTierWorkSpec>>
>;

/** `Work.status.components[]` — `AppsTierComponentStatus` (plan §3.1:261). */
const COMPONENT_STATUS_PROPERTIES: Record<keyof AppsTierComponentStatus, JsonSchema> = {
	name: stringSchema({ description: 'Component name.', minLength: 1, maxLength: 63 }),
	readyReplicas: integerSchema({ description: 'Ready replicas.', minimum: 0 }),
	replicas: integerSchema({ description: 'Desired replicas.', minimum: 0 }),
	imageDigest: stringSchema({
		description: 'The digest actually running (`sha256:<64 hex>`).',
		minLength: 1,
		maxLength: 71
	})
};

/** `Work.status.jobs[]` — `AppsTierJobStatusView` (plan §3.1:262, GAP-25). */
const JOB_STATUS_PROPERTIES: Record<keyof AppsTierJobStatusView, JsonSchema> = {
	name: stringSchema({ description: 'Job name.', minLength: 1, maxLength: 63 }),
	when: { type: 'string', enum: APPS_TIER_JOB_PHASES, description: 'The job phase it ran in.' },
	runName: stringSchema({ description: 'The workload that ran it.', maxLength: 253 }),
	status: { type: 'string', enum: APPS_TIER_JOB_STATUSES, description: 'Job outcome.' },
	startedAt: nullableStringSchema('When it started; `null` while it has not.'),
	completedAt: nullableStringSchema('When it finished; `null` while it has not.'),
	exitCode: nullable(integerSchema({ description: 'Exit code, when there is one.' }))
};

/** `Work.status.smoke[]` — `AppsTierSmokeStatusView` (plan §3.1:263, GAP-25). */
const SMOKE_STATUS_PROPERTIES: Record<keyof AppsTierSmokeStatusView, JsonSchema> = {
	name: stringSchema({ description: 'Smoke check name.', minLength: 1, maxLength: 63 }),
	scope: { type: 'string', enum: APPS_TIER_SMOKE_SCOPES, description: '`in-cluster` or `public`.' },
	status: { type: 'string', enum: APPS_TIER_SMOKE_STATUSES, description: '`passed` | `failed` | `skipped`.' },
	httpStatus: nullable(integerSchema({ description: 'Observed HTTP status.', minimum: 0, maximum: 599 })),
	latencyMs: nullable(numberSchema({ description: 'Observed latency.', minimum: 0 })),
	failedExpectation: nullableStringSchema('The expectation that failed, when one did.'),
	found: nullable(
		stringSchema({ description: 'What was found instead, at most 200 characters — plan §3.1:263.', maxLength: 200 })
	)
};

/** `Work.status.dependencies[]` — `AppsTierDependencyStatusView` (plan §3.1:258, CONTRACTS §3). */
const DEPENDENCY_STATUS_PROPERTIES: Record<keyof AppsTierDependencyStatusView, JsonSchema> = {
	kind: { type: 'string', enum: APP_DEPENDENCY_KINDS, description: 'The dependency kind.' },
	ref: stringSchema({ description: 'The zone-side reference.', minLength: 1, maxLength: 128 }),
	phase: {
		type: 'string',
		enum: APPS_TIER_DEPENDENCY_PHASES,
		description: '`pending` | `ready` | `failed` | `released`; `released` gates data deletion (spec FR-54).'
	},
	lastBackupAt: nullableStringSchema('When the dependency was last backed up, when that is known.'),
	detail: {
		type: 'object',
		description: 'Provider detail — never a credential (CONTRACTS §3).',
		additionalProperties: { type: ['string', 'number'] }
	}
};

/** `Work.status.removal` — `AppsTierRemovalStatus` (plan §2.6:203–211, §3.1:257; R-15). */
const REMOVAL_STATUS_PROPERTIES: Record<keyof AppsTierRemovalStatus, JsonSchema> = {
	removedAt: nullableStringSchema('When the workloads were removed.'),
	retainedUntil: nullableStringSchema('The end of the 30-day data retention (plan §2.6).'),
	dataDeletedAt: nullableStringSchema('When the stored data was deleted, after the dependencies were released.')
};

/** `Work.status.refusal` — `AppsTierWorkRefusal` (spec FR-27, plan §3.1:260). */
const REFUSAL_PROPERTIES: Record<keyof AppsTierWorkRefusal, JsonSchema> = {
	code: {
		type: 'string',
		enum: APPS_TIER_WORK_REFUSAL_CODES,
		description: 'The machine refusal code — plan §3.1:273–281.'
	},
	field: stringSchema({ description: 'The field the refusal concerns.', minLength: 1, maxLength: 512 })
};

/** `Work.status.promotion[]` — `AppsTierPromotion` (plan §3.1:267). */
const PROMOTION_PROPERTIES: Record<keyof AppsTierPromotion, JsonSchema> = {
	component: stringSchema({ description: 'Component name.', minLength: 1, maxLength: 63 }),
	digest: stringSchema({ description: 'The promoted digest.', minLength: 1, maxLength: 71 }),
	scan: closedObject(
		{
			critical: integerSchema({ minimum: 0 }),
			criticalFixable: integerSchema({ minimum: 0 }),
			high: integerSchema({ minimum: 0 })
		},
		{
			description: 'The scan counts that decide deployability (spec FR-31, plan §3.1:267).',
			required: ['critical', 'criticalFixable', 'high']
		}
	),
	signed: { type: 'boolean', description: 'Whether the zone signed the digest.' },
	allowanceRef: nullableStringSchema('The operator allowance that let a fixable-critical image run, when one did.')
};

/** `Work.status.quarantine` — `AppsTierQuarantineStatus` (plan §2.5, §3.1:265–266). */
const QUARANTINE_STATUS_PROPERTIES: Record<keyof AppsTierQuarantineStatus, JsonSchema> = {
	requestId: stringSchema({ description: 'Echo of `spec.quarantine.requestId`.', pattern: UUID_PATTERN }),
	source: {
		type: 'string',
		enum: ['operator', 'detector', 'self-check'],
		description: 'Who asked for it — plan §3.1:265.'
	},
	networkIsolatedAt: nullableStringSchema('When the isolation policy landed (LG-18 budget 15 s).'),
	scaledToZeroAt: nullableStringSchema('When the workloads were scaled to zero (budget 60 s).'),
	ingressDisabledAt: nullableStringSchema('When the hosts were moved to the unavailable backend (budget 120 s).'),
	replicasBefore: {
		type: 'object',
		description: 'The replica counts recorded before scaling to zero, restored on release (plan §2.5).',
		maxProperties: APPS_TIER_MAX_COMPONENTS,
		additionalProperties: integerSchema({ minimum: 0, maximum: APPS_TIER_MAX_COMPONENT_REPLICAS })
	},
	releasedAt: nullableStringSchema('When the release finished (budget 180 s).'),
	policiesSuspended: stringArraySchema({
		description: 'The policies suspended for the quarantine, restored on release.',
		maxItems: 64
	})
};

/** `Work.status` — every member of `AppsTierWorkStatus` (plan §3.1:254–269). */
const WORK_STATUS_PROPERTIES: Record<keyof AppsTierWorkStatus, JsonSchema> = {
	phase: {
		type: 'string',
		enum: APPS_TIER_WORK_PHASES,
		description: 'The Work phase — spec FR-27:298–299. `Removed` is the last of them.'
	},
	observedGeneration: integerSchema({ description: 'The `spec.generation` this status describes.', minimum: 0 }),
	removal: closedObject(REMOVAL_STATUS_PROPERTIES, {
		description: 'The removal record — plan §2.6, §3.1:257.',
		required: ['removedAt', 'retainedUntil', 'dataDeletedAt']
	}),
	dependencies: arrayOf(
		closedObject(DEPENDENCY_STATUS_PROPERTIES, { required: ['kind', 'ref', 'phase', 'lastBackupAt'] }),
		{
			description: 'One row per managed dependency (plan §3.1:258).'
		}
	),
	namespace: stringSchema({
		description: 'The tenant namespace the controller assigned (`ewa-<first 20 hex of workId>`) — plan §3.1:259.',
		pattern: TENANT_NAMESPACE_PATTERN
	}),
	refusal: nullable(closedObject(REFUSAL_PROPERTIES, { required: ['code', 'field'] })),
	components: arrayOf(
		closedObject(COMPONENT_STATUS_PROPERTIES, { required: ['name', 'readyReplicas', 'replicas', 'imageDigest'] }),
		{
			description: 'Per-component readiness and running digest — spec FR-27.'
		}
	),
	jobs: arrayOf(
		closedObject(JOB_STATUS_PROPERTIES, {
			required: ['name', 'when', 'runName', 'status', 'startedAt', 'completedAt', 'exitCode']
		})
	),
	smoke: arrayOf(
		closedObject(SMOKE_STATUS_PROPERTIES, {
			required: ['name', 'scope', 'status', 'httpStatus', 'latencyMs', 'failedExpectation', 'found']
		})
	),
	deployPhase: {
		type: ['string', 'null'],
		enum: [...APPS_TIER_DEPLOY_PHASES, null],
		description: 'The deployment sequencer’s position — plan §3.1:264.'
	},
	quarantine: nullable(
		closedObject(QUARANTINE_STATUS_PROPERTIES, {
			required: [
				'requestId',
				'source',
				'networkIsolatedAt',
				'scaledToZeroAt',
				'ingressDisabledAt',
				'replicasBefore',
				'releasedAt',
				'policiesSuspended'
			]
		})
	),
	promotion: arrayOf(
		closedObject(PROMOTION_PROPERTIES, { required: ['component', 'digest', 'scan', 'signed', 'allowanceRef'] })
	),
	policyRevision: stringSchema({
		description: 'The zone policy revision the Work was last reconciled against.',
		maxLength: 64
	}),
	controllerVersion: stringSchema({ description: 'The controller version that wrote this status.', maxLength: 64 }),
	conditions: arrayOf(
		closedObject(
			{
				type: stringSchema({ description: 'Condition type.', minLength: 1, maxLength: 128 }),
				status: stringSchema({
					description: 'Condition status (`True` / `False` / `Unknown`).',
					minLength: 1,
					maxLength: 32
				}),
				reason: stringSchema({ description: 'Condition reason.', maxLength: 128 }),
				message: stringSchema({ description: 'Human-readable message.', maxLength: 1_024 })
			},
			{ required: ['type', 'status', 'reason', 'message'] }
		),
		{ description: 'Standard conditions — plan §3.1:269.' }
	)
};

/** `Work` — plan §3.1. */
export const WORK_CRD_DEFINITION: CrdDefinition = {
	kind: 'Work',
	plural: 'works',
	singular: 'work',
	openAPIV3Schema: rootSchema(
		'Work',
		closedObject(WORK_SPEC_PROPERTIES, {
			description:
				'The desired state of one App Work on the hosting tier (plan §3.1:230–253). Closed: an unknown field, a `namespace` among them, is refused (ACC-10-26).',
			required: WORK_SPEC_REQUIRED
		}),
		closedObject(WORK_STATUS_PROPERTIES, {
			description:
				'Everything the platform reads back (plan §3.1:254–269). Written by the zone, never by the platform.'
		})
	)
};

/** The `Work` CRD manifest, as `deploy/crds/works.yaml` carries it. */
export const WORK_CRD: CustomResourceDefinitionManifest = customResourceDefinition(WORK_CRD_DEFINITION);
