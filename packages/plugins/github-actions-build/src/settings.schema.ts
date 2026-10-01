import type { JsonSchema } from '@ever-works/plugin';

/**
 * APW-05 T7 — the `github-actions-build` plugin settings (plan §4.4, setting by
 * setting), and the one place the two platform-managed keys are declared.
 *
 * Every key, default, bound and marker below is transcribed from plan §4.4's
 * table. Nothing is invented: no key appears that the table does not state, so a
 * tightening of this schema cannot silently refuse a configuration the plan
 * allows.
 *
 * ## What is load-bearing here, and why (pinned by
 * `src/__tests__/plugin.manifest.spec.ts` rather than asserted in prose)
 *
 *   - **`pullToken` is `x-secret`** (Constitution VII, plan §4.12). The marker is
 *     the only thing that makes the platform treat the value as a secret:
 *     `packages/plugin/src/api/api-response.types.ts` turns it into
 *     `secret: true` on the descriptor every API response is built from, and
 *     `plugin-operations.service.ts` masks exactly those fields. Drop the marker
 *     and the pull token becomes an ordinary setting, readable back out of the
 *     settings API.
 *   - **`pullToken` and `pullTokenExpiresAt` are `x-platformManaged`** (plan
 *     §4.4, `APW05-G07`): only `AppBuildPullTokenService.save` (APW-05 T29)
 *     writes them, through `PluginSettingsService.writePlatformManagedWorkSettings`,
 *     and the generic settings PATCH route must refuse both at every scope.
 *   - **no preparation key is declared** (`APW05-G03`). `workflowSha256`,
 *     `workflowPullRequestNumber`, `webhookId`, `runsEtag` and `repositoryBlock`
 *     are *preparation* state: their one home is the per-App-Work
 *     `work_build_preparations` row (plan §3.1b, landed in APW-05 T4/T5/T6), so
 *     a user cannot PATCH what only the platform may write. Declaring one here
 *     would put it back in reach of the settings API.
 *
 * ## `x-platformManaged` and the shared schema type
 *
 * `PluginSchemaExtensions` (`packages/plugin/src/settings/json-schema.types.ts`)
 * does not declare `x-platformManaged`, and `PluginSettingsService.validateSettingsScope`
 * (`packages/agent/src/plugins/services/plugin-settings.service.ts:812`) does not
 * read it yet. Both files belong to other epics' slices, so the marker is
 * declared **locally** by {@link PlatformManagedJsonSchema} — the narrowest
 * annotation that lets plan §4.4's two markers exist in the schema today without
 * a cast that would hide them. When the shared type grows the flag, this
 * interface collapses to `JsonSchema` and nothing else moves. Until the service
 * reads it, the marker is declared and asserted here while the refusal it
 * enables is T29's (`APW05-G07`).
 */

/**
 * `JsonSchema` plus plan §4.4's platform-managed marker.
 *
 * A local widening, deliberately: the shared extension interface is owned by
 * another slice (see the file docstring).
 */
export interface PlatformManagedJsonSchema extends JsonSchema {
	/** Written by the platform only; the settings PATCH route refuses it at every scope (plan §4.4, `APW05-G07`). */
	readonly 'x-platformManaged'?: boolean;
}

/** This plugin's settings schema — a {@link JsonSchema} whose properties may carry {@link PlatformManagedJsonSchema}. */
export interface GitHubActionsBuildSettingsSchema extends JsonSchema {
	readonly properties?: Record<string, JsonSchema | PlatformManagedJsonSchema>;
}

/** `largerRunnerLabel` (plan §4.4): private repositories only, when set. */
export const LARGER_RUNNER_LABEL_PATTERN = '^[A-Za-z0-9._-]{1,64}$';

/** Memory the platform reserves before a declared `memoryGiB` is allowed to fit (plan §4.4: `memory − 2`). */
export const LARGER_RUNNER_MEMORY_MIN_GIB = 8;

/** Upper bound of `largerRunnerMemoryGiB` (plan §4.4). */
export const LARGER_RUNNER_MEMORY_MAX_GIB = 256;

/** Lower bound of `largerRunnerVcpu` (plan §4.4). */
export const LARGER_RUNNER_VCPU_MIN = 2;

/** Upper bound of `largerRunnerVcpu` (plan §4.4). */
export const LARGER_RUNNER_VCPU_MAX = 64;

/**
 * Every settings key this plugin declares, in plan §4.4's table order.
 *
 * Exported so the spec can assert the set, the order and the markers against one
 * list instead of three hand-copied ones.
 */
export const GITHUB_ACTIONS_BUILD_SETTING_KEYS = [
	'largerRunnerLabel',
	'largerRunnerMemoryGiB',
	'largerRunnerVcpu',
	'reclaimDisk',
	'attestations',
	'pullToken',
	'pullTokenExpiresAt',
	'allowBuildValuesOnPullRequests',
	'verificationPromptedValuesRequireApproval'
] as const;

/** A settings key of this plugin (plan §4.4). */
export type GitHubActionsBuildSettingKey = (typeof GITHUB_ACTIONS_BUILD_SETTING_KEYS)[number];

/** The keys the platform writes and a user may never set (plan §4.4, `APW05-G07`). */
export const GITHUB_ACTIONS_BUILD_PLATFORM_MANAGED_KEYS = ['pullToken', 'pullTokenExpiresAt'] as const;

/**
 * The preparation keys of plan §3.1b that this schema must NOT declare
 * (`APW05-G03`). Named here so the negative assertion has one authority, and so
 * the collision with the `work_build_preparations` columns is visible from the
 * plugin side too.
 */
export const PREPARATION_STATE_KEYS = [
	'workflowSha256',
	'workflowPullRequestNumber',
	'webhookId',
	'runsEtag',
	'repositoryBlock'
] as const;

/** The defaults plan §4.4 gives the four booleans and the two runner numbers. */
export const GITHUB_ACTIONS_BUILD_SETTING_DEFAULTS = {
	largerRunnerLabel: '',
	largerRunnerMemoryGiB: 0,
	largerRunnerVcpu: 0,
	reclaimDisk: true,
	attestations: false,
	allowBuildValuesOnPullRequests: false,
	verificationPromptedValuesRequireApproval: true
} as const;

/**
 * The settings this plugin reads once resolved (plan §4.4).
 *
 * `pullToken`/`pullTokenExpiresAt` are optional: they exist only after
 * `AppBuildPullTokenService` has written them (plan §4.12).
 */
export interface GitHubActionsBuildSettings {
	largerRunnerLabel?: string;
	largerRunnerMemoryGiB?: number;
	largerRunnerVcpu?: number;
	reclaimDisk?: boolean;
	attestations?: boolean;
	pullToken?: string;
	pullTokenExpiresAt?: string;
	allowBuildValuesOnPullRequests?: boolean;
	verificationPromptedValuesRequireApproval?: boolean;
}

/**
 * Plan §4.4's table as a JSON Schema.
 *
 * Scope, resolved from the table's own statements rather than from its summary
 * sentence, which pulls in two directions: the notes mark **Work scope only**
 * for `allowBuildValuesOnPullRequests` and `verificationPromptedValuesRequireApproval`
 * explicitly, and plan §4.4:799 says "Work scope only for `pullToken`,
 * `largerRunner*`, `attestations`; user and admin scope may set defaults for
 * `reclaimDisk` and `largerRunner*`". Both cannot hold for `largerRunner*`, so
 * the schema follows the second half (a user/admin **default** that a Work
 * overrides) and keeps `pullToken`, `pullTokenExpiresAt`, `attestations` and the
 * two XC-01 booleans at `x-scope: 'work'`, which is what the platform's scope
 * model can express. Recorded for T11, which owns the runner selector and reads
 * these three keys.
 */
export const gitHubActionsBuildSettingsSchema: GitHubActionsBuildSettingsSchema = {
	type: 'object',
	properties: {
		largerRunnerLabel: {
			type: 'string',
			title: 'Larger runner label',
			default: GITHUB_ACTIONS_BUILD_SETTING_DEFAULTS.largerRunnerLabel,
			pattern: LARGER_RUNNER_LABEL_PATTERN,
			description:
				'Label of a larger GitHub-hosted runner to use for private repositories, when one is configured. Leave blank to use the standard runner.'
		},
		largerRunnerMemoryGiB: {
			type: 'integer',
			title: 'Larger runner memory (GiB)',
			default: GITHUB_ACTIONS_BUILD_SETTING_DEFAULTS.largerRunnerMemoryGiB,
			minimum: LARGER_RUNNER_MEMORY_MIN_GIB,
			maximum: LARGER_RUNNER_MEMORY_MAX_GIB,
			description:
				'Memory the larger runner provides. Required when a larger runner label is set — the memory check cannot run without it. 0 means "no larger runner".'
		},
		largerRunnerVcpu: {
			type: 'integer',
			title: 'Larger runner vCPU',
			default: GITHUB_ACTIONS_BUILD_SETTING_DEFAULTS.largerRunnerVcpu,
			minimum: LARGER_RUNNER_VCPU_MIN,
			maximum: LARGER_RUNNER_VCPU_MAX,
			description:
				'CPU the larger runner provides. Informational: a declared CPU above it produces a warning, never a blocked Build.'
		},
		reclaimDisk: {
			type: 'boolean',
			title: 'Reclaim runner disk before building',
			default: GITHUB_ACTIONS_BUILD_SETTING_DEFAULTS.reclaimDisk,
			description: 'Removes preinstalled toolchains the build does not need, so a large image fits on the runner.'
		},
		attestations: {
			type: 'boolean',
			title: 'Publish build provenance attestations',
			default: GITHUB_ACTIONS_BUILD_SETTING_DEFAULTS.attestations,
			description:
				'Public repositories only. On a private repository this is ignored: the generated workflow grants the attestation permissions only when the repository is public.',
			'x-scope': 'work'
		},
		pullToken: {
			type: 'string',
			title: 'Registry pull token',
			description:
				'Written by Ever Works after the token is validated against the built image; never typed here and never returned by an endpoint.',
			'x-secret': true,
			'x-scope': 'work',
			'x-widget': 'password',
			'x-platformManaged': true
		},
		pullTokenExpiresAt: {
			type: 'string',
			title: 'Registry pull token expires at',
			description: 'Recorded by Ever Works from the token provider when the token was saved. Read-only.',
			'x-scope': 'work',
			'x-platformManaged': true
		},
		allowBuildValuesOnPullRequests: {
			type: 'boolean',
			title: 'Send stored build values to pull requests',
			default: GITHUB_ACTIONS_BUILD_SETTING_DEFAULTS.allowBuildValuesOnPullRequests,
			description:
				'When on, a pull request from this repository receives the stored build values — which means whatever code the pull request contains can read them. Leave off unless the build genuinely needs a stored value on a pull request.',
			'x-scope': 'work'
		},
		verificationPromptedValuesRequireApproval: {
			type: 'boolean',
			title: 'Require approval before a verification uses prompted values',
			default: GITHUB_ACTIONS_BUILD_SETTING_DEFAULTS.verificationPromptedValuesRequireApproval,
			description:
				'When on, a verification receives owner-set prompted values only when the change under verification touches no build-affecting file, or the owner approved it.',
			'x-scope': 'work'
		}
	},
	// plan §4.4: `largerRunnerMemoryGiB` is "required when the label is set (the
	// memory check needs it)". JSON Schema is the only place this can be stated
	// before a Build exists, and the platform's validator runs with
	// `useDefaults: false`, so an absent key stays absent and this `required`
	// really fires.
	allOf: [
		{
			if: { properties: { largerRunnerLabel: { minLength: 1 } }, required: ['largerRunnerLabel'] },
			then: { required: ['largerRunnerMemoryGiB'] }
		}
	]
};
