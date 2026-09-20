/**
 * T3 — the `AppBuild` CRD (APW-10 plan §3.2:307–309, P3; tasks T3, T33).
 *
 * The zone builds one App Work inside its own sandboxed capacity (WG-3 / Resolution R-24): the
 * platform writes `spec` (what to build, with the repository credential **sealed** to the
 * controller's key), the controller writes `status` (phase, the digest it produced, the scan
 * summary, the signature state and the egress hosts the sandbox refused).
 *
 * `status` mirrors `AppsTierBuildStatus` and its two structured members are APW-05's own
 * declarations — `AppBuildScanSummary` and `AppBuildSignatureState`
 * (`packages/contracts/src/apps/builds.ts`) — so a zone status and a Build row agree without a
 * mapping table. `status.phase` stays a plain string exactly as the plan leaves it: the phase
 * vocabulary belongs to T33's reconciler, and a closed union here would be narrower than the
 * status it reports.
 *
 * `spec.sealedSourceToken` never leaves the zone in the clear: it is a sealed payload like any
 * other, bounded by the same 256 KiB seal ceiling the plan gives a sealed environment, and it
 * appears in no status field.
 */
import type { AppBuildScanSummary } from '@ever-works/contracts';
import { APP_BUILD_SIGNATURE_STATES, APPS_TIER_MAX_SEALED_ENV_BYTES } from '@ever-works/contracts';
import type { AppsTierBuildRequest, AppsTierBuildStatus, AppBuildBlock } from '@ever-works/plugin';

import type { CrdDefinition, CustomResourceDefinitionManifest, JsonSchema } from './crd.js';
import { customResourceDefinition, rootSchema } from './crd.js';
import {
	UUID_PATTERN,
	arrayOf,
	base64EncodedLength,
	closedObject,
	integerSchema,
	nullableStringSchema,
	stringArraySchema,
	stringSchema
} from './json-schema.js';

/** One `--build-arg` — `AppBuildBlock['args'][number]`, APW-05's own shape. */
type BuildArg = AppBuildBlock['args'][number];

/** A build argument: a literal value or one taken from the build's environment. */
const BUILD_ARG_PROPERTIES: Record<keyof BuildArg, JsonSchema> = {
	name: stringSchema({ description: 'The argument name.', minLength: 1, maxLength: 253 }),
	value: stringSchema({ description: 'A literal value.', maxLength: 65_536 }),
	fromEnv: stringSchema({ description: 'The name of the environment variable carrying the value.', maxLength: 253 })
};

/** `AppBuild.spec` — `AppsTierBuildRequest` (plan §3.2:307–308). */
const APP_BUILD_SPEC_PROPERTIES: Record<keyof AppsTierBuildRequest, JsonSchema> = {
	workId: stringSchema({ description: 'The Work being built.', pattern: UUID_PATTERN }),
	buildId: stringSchema({ description: 'The Build row this object answers — APW-05’s id.', pattern: UUID_PATTERN }),
	sourceRepo: stringSchema({ description: 'The repository to build from.', minLength: 1, maxLength: 512 }),
	commitSha: stringSchema({ description: 'The commit to build.', pattern: '^[0-9a-f]{40}$' }),
	dockerfile: stringSchema({ description: 'Path to the Dockerfile, when the strategy uses one.', maxLength: 512 }),
	context: stringSchema({ description: 'Build context path, when the strategy uses one.', maxLength: 512 }),
	target: stringSchema({ description: 'The multi-stage target to build.', maxLength: 253 }),
	args: arrayOf(closedObject(BUILD_ARG_PROPERTIES, { required: ['name'] }), {
		description: 'Build arguments — APW-05’s `AppBuildBlock.args`.',
		maxItems: 128
	}),
	sealedSourceToken: stringSchema({
		description: `The repository credential, sealed to the controller key (base64, ≤ ${APPS_TIER_MAX_SEALED_ENV_BYTES} bytes). Never returned in status.`,
		minLength: 1,
		maxLength: base64EncodedLength(APPS_TIER_MAX_SEALED_ENV_BYTES)
	}),
	caps: closedObject(
		{ timeoutSeconds: integerSchema({ description: 'The whole-run cap LG-25 enforces (T33).', minimum: 1 }) },
		{ description: 'The build’s hard caps — spec FR-49, LG-25.', required: ['timeoutSeconds'] }
	)
};

/** `AppBuild.status.scanSummary` — APW-05's `AppBuildScanSummary`. */
const SCAN_SUMMARY_PROPERTIES: Record<keyof AppBuildScanSummary, JsonSchema> = {
	critical: integerSchema({ minimum: 0 }),
	high: integerSchema({ minimum: 0 }),
	medium: integerSchema({ minimum: 0 }),
	low: integerSchema({ minimum: 0 }),
	fixableCritical: integerSchema({ minimum: 0 })
};

/** `AppBuild.status` — `AppsTierBuildStatus` (plan §3.2:309). */
const APP_BUILD_STATUS_PROPERTIES: Record<keyof AppsTierBuildStatus, JsonSchema> = {
	phase: stringSchema({
		description: 'The reconciler’s phase (T33 owns the vocabulary).',
		minLength: 1,
		maxLength: 32
	}),
	imageDigest: nullableStringSchema('The digest the build produced.'),
	scanSummary: {
		type: ['object', 'null'],
		description: 'The scan counts — APW-05’s `AppBuildScanSummary`.',
		properties: SCAN_SUMMARY_PROPERTIES,
		additionalProperties: false,
		required: ['critical', 'high', 'medium', 'low', 'fixableCritical']
	},
	signatureState: {
		type: ['string', 'null'],
		enum: [...APP_BUILD_SIGNATURE_STATES, null],
		description: '`signed` | `unsigned` | `foreign` — APW-05’s `AppBuildSignatureState`.'
	},
	blockedEgressHosts: stringArraySchema({
		description: 'Hosts the build sandbox refused — LG-24’s own evidence.',
		maxItems: 256
	}),
	startedAt: nullableStringSchema('When the build started.'),
	finishedAt: nullableStringSchema('When the build finished or hit its cap.')
};

/** `AppBuild` — plan §3.2:307–309. */
export const APP_BUILD_CRD_DEFINITION: CrdDefinition = {
	kind: 'AppBuild',
	plural: 'appbuilds',
	singular: 'appbuild',
	openAPIV3Schema: rootSchema(
		'AppBuild',
		closedObject(APP_BUILD_SPEC_PROPERTIES, {
			description: 'One sandboxed in-zone build (P3; plan §3.2:307–308).',
			required: ['workId', 'buildId', 'sourceRepo', 'commitSha', 'args', 'sealedSourceToken', 'caps']
		}),
		closedObject(APP_BUILD_STATUS_PROPERTIES, {
			description: 'What the zone’s build reconciler reports (T33).'
		})
	)
};

/** The `AppBuild` CRD manifest, as `deploy/crds/appbuild.yaml` carries it. */
export const APP_BUILD_CRD: CustomResourceDefinitionManifest = customResourceDefinition(APP_BUILD_CRD_DEFINITION);
