/**
 * APW-10 T2 — the `apps-tier` capability, `IAppsTierProvider` and the types it
 * names (plan §5.1:546–598, tasks T2:73–81).
 *
 * `apps-tier.interface.ts` and `apps-tier.types.ts` are pinned by their own
 * compile-time shape: every fixture below is annotated with the plan's types, so
 * a member the plan names cannot be renamed, dropped or made required by
 * accident — and a member the plan does NOT name cannot be added to the
 * interface — without `tsc -p tsconfig.specs.json` failing. What this spec exists
 * for is the five things a capability can silently get wrong:
 *
 *  1. **the constant is the string the plan names**, so the `ever-works-apps`
 *     manifest (`capabilities: ['apps-tier', 'deployment']`, plan §5.2:602), the
 *     facade's resolution and the R-1 key all agree;
 *  2. **nothing was removed to make room for it.** `PLUGIN_CAPABILITIES` is an
 *     append-only surface: a member that is dropped, renamed or *reordered*
 *     silently changes what a persisted manifest means, and the failure shows up
 *     as a plugin that loads with fewer capabilities than it has — never as an
 *     error. `EXISTING_CAPABILITY_ENTRIES` below is the pre-T2 snapshot taken
 *     from `HEAD`, and the whole table is compared **in order**, so a
 *     mid-object insertion, a rename or a revalue fails here;
 *  3. **no category was appended.** T2 changes no category (plan §5.2:602 makes
 *     the tier's plugin a `deployment` plugin): `PLUGIN_CATEGORIES` is pinned to
 *     its 27-member snapshot, and a mid-tuple insertion — which renumbers every
 *     index a consumer persisted — fails here as well as in the three specs that
 *     already pin the tuple;
 *  4. **the two P3 members stay optional and `removeWork`'s `deleteData` stays
 *     required.** Both are asserted twice: once as a type-level pin that flips
 *     the moment the optionality changes, and once as an unused-or-used
 *     `@ts-expect-error` that fails the compile in the opposite direction;
 *  5. **the metered units the pricebook names are the fields the report
 *     carries.** The usage report's non-housekeeping fields are compared against
 *     T1's `APPS_TIER_USAGE_UNITS` **both ways**, so a unit cannot be billed
 *     without arriving and a field cannot arrive without being billable.
 */

import { describe, expect, it } from 'vitest';
import {
	APPS_TIER_SIGNAL_KINDS,
	APPS_TIER_SIGNAL_SEVERITIES,
	APPS_TIER_SIGNAL_SUMMARY_MAX_CHARS,
	APPS_TIER_USAGE_UNITS,
	APPS_TIER_WORK_DESIRED_STATES,
	APP_BUILD_SIGNATURE_STATES,
	type AppsTierDependencyRef as ContractsDependencyRef,
	type AppsTierWorkSpec as ContractsWorkSpec
} from '@ever-works/contracts';
import { PLUGIN_CATEGORIES, isPluginCategory, type PluginCategory } from '../plugin-manifest.types.js';
import { PLUGIN_CAPABILITIES, isValidPluginCapability, type PluginCapability } from '../facade-capabilities.js';
import {
	APPS_TIER_LOG_UNAVAILABLE_CODE,
	APPS_TIER_SELF_CHECK_PHASES,
	type AppsTierAbuseSignalReport,
	type AppsTierAccessReview,
	type AppsTierBuildStatus,
	type AppsTierDependencyRef,
	type AppsTierDependencyStatusView,
	type AppsTierHeartbeat,
	type AppsTierLogPage,
	type AppsTierLogRequest,
	type AppsTierQuarantineRequest,
	type AppsTierSelfCheckResult,
	type AppsTierSelfCheckStatus,
	type AppsTierUsageReport,
	type AppsTierWorkDesiredState,
	type AppsTierWorkSpec,
	type AppsTierWorkStatus,
	type AppsTierZoneInfo
} from '../capabilities/apps-tier.types.js';
import type { IAppsTierProvider } from '../capabilities/apps-tier.interface.js';
import * as contractsBarrel from '../index.js';
import type { IPlugin } from '../plugin.interface.js';
import type { JsonSchema } from '../../settings/json-schema.types.js';

/**
 * Every `[key, value]` pair of `PLUGIN_CAPABILITIES` that existed before APW-10
 * T2 appended `APPS_TIER`, in `facade-capabilities.ts`'s own order.
 *
 * Taken from that file at `HEAD` rather than hand-written from the category
 * tuple: the capability values are not the category names
 * (`form-schema-provider`, not `form`), and the KEYS matter as much as the
 * values — `PLUGIN_CAPABILITIES.BUILD` is read by `BuildFacadeService`, so a
 * renamed key breaks a consumer that a values-only check would wave through.
 */
const EXISTING_CAPABILITY_ENTRIES: ReadonlyArray<[string, string]> = [
	['AI_PROVIDER', 'ai-provider'],
	['SEARCH', 'search'],
	['SCREENSHOT', 'screenshot'],
	['CONTENT_EXTRACTOR', 'content-extractor'],
	['DATA_SOURCE', 'data-source'],
	['PIPELINE', 'pipeline'],
	['PIPELINE_MODIFIER', 'pipeline-modifier'],
	['CODE_EDIT', 'code-edit'],
	['FORM_SCHEMA_PROVIDER', 'form-schema-provider'],
	['DEPLOYMENT', 'deployment'],
	['GIT_PROVIDER', 'git-provider'],
	['OAUTH', 'oauth'],
	['DEVICE_AUTH', 'device-auth'],
	['PROMPT_PROVIDER', 'prompt-provider'],
	['STORAGE', 'storage'],
	['PUT_OBJECT', 'put-object'],
	['GET_OBJECT', 'get-object'],
	['PRESIGNED_PUT', 'presigned-put'],
	['SKILLS_PROVIDER', 'skills-provider'],
	['TASK_TRACKER', 'task-tracker'],
	['EMAIL_OUTBOUND', 'email-outbound'],
	['EMAIL_INBOUND', 'email-inbound'],
	['NOTIFICATION_CHANNEL', 'notification-channel'],
	['NOTIFICATION_CHANNEL_DISCORD', 'notification-channel-discord'],
	['NOTIFICATION_CHANNEL_SLACK', 'notification-channel-slack'],
	['NOTIFICATION_CHANNEL_TELEGRAM', 'notification-channel-telegram'],
	['NOTIFICATION_CHANNEL_WHATSAPP', 'notification-channel-whatsapp'],
	['NOTIFICATION_CHANNEL_NOVU', 'notification-channel-novu'],
	['CONNECTOR', 'connector'],
	['CONNECTOR_SLACK', 'connector-slack'],
	['CONNECTOR_DISCORD', 'connector-discord'],
	['CONNECTOR_WHATSAPP', 'connector-whatsapp'],
	['CONNECTOR_LINEAR', 'connector-linear'],
	['CONNECTOR_NOTION', 'connector-notion'],
	['CONNECTOR_MICROSOFT_365', 'connector-microsoft-365'],
	['CONNECTOR_HUBSPOT', 'connector-hubspot'],
	['CONNECTOR_PIPEDRIVE', 'connector-pipedrive'],
	['CONNECTOR_BLUESKY', 'connector-bluesky'],
	['CONNECTOR_MASTODON', 'connector-mastodon'],
	['AGENT_MEMORY', 'agent-memory'],
	['METRICS_PROVIDER', 'metrics-provider'],
	['TERMINAL_STREAM', 'terminal-stream'],
	['WORKSPACE', 'workspace'],
	['BROWSER_AUTOMATION', 'browser-automation'],
	['EVENT_SOURCE', 'event-source'],
	['PLAYBOOK_PROVIDER', 'playbook-provider'],
	['CONNECTION_SCOPES', 'connection-scopes'],
	['APP_DEPENDENCY', 'app-dependency'],
	['BUILD', 'build'],
	['IDENTITY_PROVIDER', 'identity-provider']
];

/** Every category that existed before T2, in the tuple's own order. T2 appends none. */
const PRE_APPS_TIER_CATEGORIES: readonly string[] = [
	'git-provider',
	'deployment',
	'screenshot',
	'search',
	'content-extractor',
	'data-source',
	'ai-provider',
	'pipeline',
	'form',
	'integration',
	'utility',
	'theme',
	'storage',
	'database',
	'email-provider',
	'notification-channel',
	'connector',
	'vector-store',
	'dns',
	'secret-store-resolver',
	'job-runtime',
	'memory',
	'rag',
	'metrics',
	'app-dependency',
	'build',
	'identity'
];

/**
 * The twenty members of plan §5.1:549–592, in the plan's order — eighteen
 * required and the two P3 build members last. A member this list does not name
 * cannot be added to the interface (see `ExtraProviderMember` below), and a
 * member this list names cannot be renamed out of it.
 */
const PROVIDER_MEMBERS = [
	'zoneInfo',
	'applyWork',
	'getWork',
	'setDesiredState',
	'setEgressThrottle',
	'removeWork',
	'setDependencies',
	'releaseDependencies',
	'getDependencies',
	'startSelfCheck',
	'getSelfCheck',
	'reviewCredentialScope',
	'getHeartbeat',
	'listUsageReports',
	'acknowledgeUsageReports',
	'listAbuseSignals',
	'acknowledgeAbuseSignals',
	'getAppLogs',
	'submitBuild',
	'getBuild'
] as const;

/** The members plan §5.1 marks with `?` — the P3 build pair, and only those. */
const OPTIONAL_PROVIDER_MEMBERS = ['submitBuild', 'getBuild'] as const;

/** A member name the interface must have. */
type ProviderMemberName = (typeof PROVIDER_MEMBERS)[number];

/* ───────────────────── type-level pins (checked by `tsc`) ───────────────────── */

/**
 * `submitBuild` and `getBuild` are optional **and must stay optional**: they are
 * the P3 sandboxed-build path, and a provider that implements neither is a
 * complete P1/P2 provider. `{}` is assignable to their `Pick` only while both
 * carry `?`, so making either required flips this to `false` and reddens
 * `tsc -p tsconfig.specs.json`.
 */
type BuildMembersAreOptional = {} extends Pick<IAppsTierProvider, 'submitBuild' | 'getBuild'> ? true : false;
const buildMembersAreOptional: BuildMembersAreOptional = true;

/**
 * `removeWork(workId, opts)` requires the options object (no `?` on the second
 * parameter) **and** `deleteData` inside it. Removing `deleteData` from §5.1's
 * signature would silently mean "keep the data" for a caller that meant to
 * delete it (Resolution R-15), so both halves are pinned separately.
 */
type RemoveWorkOptionsParam = Parameters<IAppsTierProvider['removeWork']>[1];
type RemoveWorkOptionsParamIsRequired = undefined extends RemoveWorkOptionsParam ? false : true;
const removeWorkOptionsParamIsRequired: RemoveWorkOptionsParamIsRequired = true;
type DeleteDataIsRequired = {} extends NonNullable<RemoveWorkOptionsParam> ? false : true;
const deleteDataIsRequired: DeleteDataIsRequired = true;

/**
 * No member may be added to `IAppsTierProvider` that this spec does not name:
 * `ExtraProviderMember` collapses to `never` while the two key sets agree, so an
 * unlisted member makes the empty array below unassignable.
 */
type ExtraProviderMember = Exclude<keyof IAppsTierProvider, keyof IPlugin | ProviderMemberName>;
const noExtraProviderMembers: readonly ExtraProviderMember[] = [];

/* ─────────────────────────── typed fixtures ─────────────────────────── */

const zoneInfo: AppsTierZoneInfo = {
	appsDomain: 'user-apps.example.com',
	sandboxRuntimeClass: 'example-sandbox',
	registryHost: 'registry.example.com',
	edgeIngressClass: 'example-tier-edge',
	minPlatformVersion: '1.0.0'
};

const selfCheckResults: AppsTierSelfCheckResult[] = [
	{ id: 'LG-02', outcome: 'passed', reasonCode: null, durationMs: 1_200 },
	{ id: 'LG-13', outcome: 'failed', reasonCode: 'UNSIGNED_IMAGE_ADMITTED', durationMs: 800 }
];

const selfCheck: AppsTierSelfCheckStatus = {
	phase: 'Completed',
	startedAt: '2026-09-18T10:00:00.000Z',
	finishedAt: '2026-09-18T10:04:00.000Z',
	results: selfCheckResults,
	policyRevision: 'policy-revision-0001',
	controllerVersion: '1.0.0'
};

const accessReview: AppsTierAccessReview = {
	ok: false,
	namespace: 'example-control',
	rules: [{ apiGroups: ['hosting.example.dev'], resources: ['works'], verbs: ['get', 'list'] }],
	forbiddenChecks: [{ verb: 'get', resource: 'secrets', allowed: true }],
	reasonCode: 'CREDENTIAL_TOO_BROAD'
};

const heartbeat: AppsTierHeartbeat = { renewedAt: new Date('2026-09-18T10:00:00.000Z'), controllerVersion: '1.0.0' };

const usageReport: AppsTierUsageReport = {
	name: 'ur-work-0001-1767225600',
	workId: 'work-0001',
	windowStart: '2026-09-18T09:00:00.000Z',
	windowEnd: '2026-09-18T10:00:00.000Z',
	cpuCoreSeconds: 3_600,
	memoryMiBHours: 2_048,
	egressMiB: 1_024,
	storageGiBHours: 720,
	buildMinutes: 5,
	dependencyStorageGiBHours: 24,
	dependencyBackupGiBHours: 24,
	acknowledgedAt: null
};

const abuseSignal: AppsTierAbuseSignalReport = {
	name: 'signal-opaque-name',
	workId: 'work-0001',
	kind: 'mining',
	severity: 'high',
	observedAt: '2026-09-18T10:00:00.000Z',
	summary: 'sustained cpu with refused mining-port connections',
	ruleId: 'mining-sustained-cpu',
	test: false,
	acknowledgedAt: null,
	autoQuarantined: true
};

const quarantineRequest: AppsTierQuarantineRequest = {
	requestId: 'quarantine-0001',
	category: 'abuse',
	requestedAt: '2026-09-18T10:00:00.000Z'
};

const logRequest: AppsTierLogRequest = { component: 'web', lines: 200, secretValues: { EXAMPLE_VALUE: 'redacted' } };

const readyLogPage: AppsTierLogPage = {
	status: 'ready',
	tail: {
		containers: [{ pod: 'web-0', container: 'web', lines: ['listening'], truncated: false }],
		redactedNames: ['EXAMPLE_VALUE'],
		fetchedAt: '2026-09-18T10:00:00.000Z'
	},
	code: null
};

const unavailableLogPage: AppsTierLogPage = {
	status: 'unavailable',
	tail: null,
	code: APPS_TIER_LOG_UNAVAILABLE_CODE
};

const buildStatus: AppsTierBuildStatus = {
	phase: 'succeeded',
	imageDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000001',
	scanSummary: { critical: 0, high: 0, medium: 1, low: 2, fixableCritical: 0 },
	signatureState: 'signed',
	blockedEgressHosts: ['blocked.example.com'],
	startedAt: '2026-09-18T10:00:00.000Z',
	finishedAt: '2026-09-18T10:01:00.000Z'
};

const dependencyRefs: AppsTierDependencyRef[] = [
	{ kind: 'postgres', ref: 'dep-postgres' },
	{ kind: 'smtp', ref: 'dep-smtp' }
];

const dependencyStatuses: AppsTierDependencyStatusView[] = [
	{ kind: 'postgres', ref: 'dep-postgres', phase: 'ready', lastBackupAt: '2026-09-18T02:00:00.000Z' },
	{ kind: 'smtp', ref: 'dep-smtp', phase: 'pending', lastBackupAt: null }
];

const workSpec: AppsTierWorkSpec = {
	workId: 'work-0001',
	ownerUserId: 'user-0001',
	organizationId: null,
	generation: 3,
	quotaProfile: 'starter',
	desiredState: 'running',
	pausedReplicas: null,
	dataDeletion: null,
	quarantine: null,
	egressThrottle: false,
	images: [],
	components: [],
	jobs: [],
	cron: [],
	smoke: [],
	hosts: [],
	env: { sealed: 'sealed-env', names: [] },
	dependencies: dependencyRefs
};

const workStatus: AppsTierWorkStatus = {
	phase: 'Ready',
	observedGeneration: 3,
	removal: { removedAt: null, retainedUntil: null, dataDeletedAt: null },
	dependencies: dependencyStatuses,
	namespace: 'ewa-00000000000000000001',
	refusal: null,
	components: [],
	jobs: [],
	smoke: [],
	deployPhase: 'done',
	quarantine: null,
	promotion: [],
	policyRevision: 'policy-revision-0001',
	controllerVersion: '1.0.0',
	conditions: []
};

/** Everything the fixture's `removeWork` was asked to do, so the boolean can be read back. */
const removeWorkCalls: Array<{ workId: string; deleteData: unknown }> = [];

/** A complete provider: every one of the plan's twenty members, and nothing invented. */
const provider: IAppsTierProvider = {
	id: 'ever-works-apps',
	name: 'Ever Works Apps',
	version: '1.0.0',
	category: 'deployment',
	capabilities: [PLUGIN_CAPABILITIES.APPS_TIER, PLUGIN_CAPABILITIES.DEPLOYMENT],
	configurationMode: 'admin-only',
	settingsSchema: {} as JsonSchema,
	onLoad: async () => undefined,
	onUnload: async () => undefined,
	zoneInfo: async () => zoneInfo,
	applyWork: async (input) => ({ generation: input.generation }),
	getWork: async (workId) => (workId === workStatus.namespace ? null : workStatus),
	setDesiredState: async () => undefined,
	setEgressThrottle: async () => undefined,
	removeWork: async (workId, opts) => {
		// Read defensively on purpose: the compile-level cases above call this with a
		// short or omitted options object, and `undefined` there IS the type error
		// under test. What the assertion reads back is what the caller passed.
		const provided = opts as { deleteData?: unknown } | undefined;
		removeWorkCalls.push({ workId, deleteData: provided?.deleteData });
	},
	setDependencies: async () => undefined,
	releaseDependencies: async () => ({ remaining: [] }),
	getDependencies: async () => dependencyStatuses,
	startSelfCheck: async () => undefined,
	getSelfCheck: async () => selfCheck,
	reviewCredentialScope: async () => accessReview,
	getHeartbeat: async () => heartbeat,
	listUsageReports: async () => [usageReport],
	acknowledgeUsageReports: async () => undefined,
	listAbuseSignals: async () => [abuseSignal],
	acknowledgeAbuseSignals: async () => undefined,
	getAppLogs: async (_workId, opts) => (opts.component === 'worker' ? unavailableLogPage : readyLogPage),
	submitBuild: async () => undefined,
	getBuild: async () => buildStatus
};

/**
 * A P1/P2 provider: every required member, **no** `submitBuild` and no
 * `getBuild`. This fixture is the real proof that the two stay optional — it
 * stops compiling the moment either becomes required.
 */
const minimalProvider: IAppsTierProvider = {
	id: 'ever-works-apps-minimal',
	name: 'Ever Works Apps',
	version: '1.0.0',
	category: 'deployment',
	capabilities: ['apps-tier'],
	settingsSchema: {} as JsonSchema,
	onLoad: async () => undefined,
	onUnload: async () => undefined,
	zoneInfo: async () => zoneInfo,
	applyWork: async () => ({ generation: 1 }),
	getWork: async () => null,
	setDesiredState: async () => undefined,
	setEgressThrottle: async () => undefined,
	removeWork: async () => undefined,
	setDependencies: async () => undefined,
	releaseDependencies: async () => ({ remaining: [] }),
	getDependencies: async () => [],
	startSelfCheck: async () => undefined,
	getSelfCheck: async () => null,
	reviewCredentialScope: async () => accessReview,
	getHeartbeat: async () => ({ renewedAt: null, controllerVersion: null }),
	listUsageReports: async () => [],
	acknowledgeUsageReports: async () => undefined,
	listAbuseSignals: async () => [],
	acknowledgeAbuseSignals: async () => undefined,
	getAppLogs: async () => unavailableLogPage
};

/* ─────────────── the capability and the category (plan §5.1:595–596) ─────────────── */

describe('the apps-tier capability (APW-10 T2)', () => {
	it('names the capability exactly as the plan does', () => {
		expect(PLUGIN_CAPABILITIES.APPS_TIER).toBe('apps-tier');
		const capability: PluginCapability = PLUGIN_CAPABILITIES.APPS_TIER;
		expect(capability).toBe('apps-tier');
		expect(isValidPluginCapability('apps-tier')).toBe(true);
		// A near miss must stay invalid: `isValidPluginCapability` is what a plugin
		// manifest is validated against, so a plural, a camelCase or a hyphen
		// variant cannot exist beside the real one.
		expect(isValidPluginCapability('apps-tiers')).toBe(false);
		expect(isValidPluginCapability('appsTier')).toBe(false);
		expect(isValidPluginCapability('apps_tier')).toBe(false);
		expect(isValidPluginCapability('app-tier')).toBe(false);
		expect(isValidPluginCapability('Apps-Tier')).toBe(false);
		expect(isValidPluginCapability('apps-tier ')).toBe(false);
		expect(isValidPluginCapability(undefined)).toBe(false);
	});

	it('keeps every pre-existing capability present, unchanged and in order', () => {
		// The whole table, key AND value, position by position. This single
		// assertion fails on a removal, a rename of a key, a change of a value, a
		// mid-object insertion and a duplicate — the five ways an append-only
		// constant can be broken without a compile error.
		expect(Object.entries(PLUGIN_CAPABILITIES)).toEqual([
			...EXISTING_CAPABILITY_ENTRIES,
			['APPS_TIER', 'apps-tier']
		]);

		// Exactly one member was added, and it is last: the plan appends
		// `apps-tier` after `build` and APW-12's `identity-provider` (plan §5.1:595).
		const keys = Object.keys(PLUGIN_CAPABILITIES);
		expect(keys).toHaveLength(EXISTING_CAPABILITY_ENTRIES.length + 1);
		expect(keys[keys.length - 1]).toBe('APPS_TIER');
		expect(keys.filter((key) => key === 'APPS_TIER')).toHaveLength(1);

		// The derived lookup array follows the table, so `ALL_PLUGIN_CAPABILITIES`
		// and the guard cannot disagree with it.
		const values = Object.values(PLUGIN_CAPABILITIES) as readonly string[];
		expect(values).toEqual([...EXISTING_CAPABILITY_ENTRIES.map(([, value]) => value), 'apps-tier']);
		expect(values.filter((entry) => entry === 'apps-tier')).toHaveLength(1);
	});

	it('appends no category, and refuses apps-tier as one', () => {
		// T2 changes no category: the implementing plugin is a `deployment` plugin
		// (plan §5.2:602), which is why `apps/web`'s exhaustive category maps must
		// not be touched. A category inserted anywhere in the tuple renumbers every
		// index a consumer persisted, so the snapshot is compared position by
		// position and the length is pinned separately.
		expect(PLUGIN_CATEGORIES).toEqual([...PRE_APPS_TIER_CATEGORIES]);
		expect(PLUGIN_CATEGORIES).toHaveLength(PRE_APPS_TIER_CATEGORIES.length);
		expect(new Set(PLUGIN_CATEGORIES).size).toBe(PLUGIN_CATEGORIES.length);
		expect(PLUGIN_CATEGORIES).toContain('deployment');

		// The capability is not a category: one spelling apart, and swapping them
		// is a manifest the loader rejects.
		expect(isPluginCategory('apps-tier')).toBe(false);
		expect(isPluginCategory('deployment')).toBe(true);
		expect(isPluginCategory('apps_tier')).toBe(false);
		const asCategory: PluginCategory = 'deployment';
		expect(PLUGIN_CATEGORIES).toContain(asCategory);
	});
});

/* ─────────────── the interface (plan §5.1:548–593) ─────────────── */

describe('IAppsTierProvider (APW-10 T2)', () => {
	it('declares exactly the plan’s twenty members, and nothing else', () => {
		// Compile-level both ways: every name below must be a member, and
		// `noExtraProviderMembers` is `never[]` only while the interface has no
		// member this list omits. A member added without editing this spec, or one
		// renamed out of it, fails `tsc -p tsconfig.specs.json`.
		const declared: readonly ProviderMemberName[] = PROVIDER_MEMBERS;
		expect(declared).toHaveLength(20);
		expect(new Set(declared).size).toBe(20);
		expect(noExtraProviderMembers).toEqual([]);

		for (const member of PROVIDER_MEMBERS) {
			expect(typeof provider[member], member).toBe('function');
		}
		// …and the fixture implements no member the plan does not name: its
		// function-valued keys are the interface's two lifecycle methods and the
		// plan's twenty, in the plan's order — nothing else.
		const functionKeys = Object.keys(provider).filter(
			(key) => typeof (provider as unknown as Record<string, unknown>)[key] === 'function'
		);
		expect(functionKeys).toEqual(['onLoad', 'onUnload', ...PROVIDER_MEMBERS]);
	});

	it('keeps submitBuild and getBuild optional, and works without them', async () => {
		// The type-level pin: `{}` is assignable to their `Pick` only while both
		// carry `?`. Making either required flips the pin to `false` and the const
		// below stops compiling.
		expect(buildMembersAreOptional).toBe(true);

		// …and the runtime half: a provider that implements neither satisfies the
		// interface, and a caller materialises the member before calling it.
		for (const member of OPTIONAL_PROVIDER_MEMBERS) {
			expect(member in minimalProvider, member).toBe(false);
			expect(minimalProvider[member], member).toBeUndefined();
		}
		await expect(minimalProvider.applyWork(workSpec)).resolves.toEqual({ generation: 1 });

		// The full provider implements both, with the shapes plan §5.1 names.
		await expect(
			provider.submitBuild?.({
				workId: 'work-0001',
				buildId: 'build-0001',
				sourceRepo: 'example-owner/example-repo',
				commitSha: '0000000000000000000000000000000000000001',
				dockerfile: 'Dockerfile',
				context: '.',
				target: 'runtime',
				args: [{ name: 'EXAMPLE_ARG', value: '1' }],
				sealedSourceToken: 'sealed-source-token',
				caps: { timeoutSeconds: 60 }
			})
		).resolves.toBeUndefined();
		await expect(provider.getBuild?.('build-0001')).resolves.toEqual(buildStatus);
	});

	it('requires removeWork’s deleteData option, and passes the boolean through unchanged', async () => {
		// The type-level pins: the options object itself is required (an optional
		// parameter contributes `undefined` to its type) and so is `deleteData`
		// (`{}` is not assignable to a type with a required member).
		expect(removeWorkOptionsParamIsRequired).toBe(true);
		expect(deleteDataIsRequired).toBe(true);

		// The same two facts read the other way round. Each directive is an error
		// the moment its line becomes legal — an unused `@ts-expect-error` is a
		// compile failure — so a `deleteData?:` or an `opts?:` in the interface
		// reddens all three of these lines.
		// @ts-expect-error `deleteData` is required: an omitted key would silently mean "keep the data" (R-15)
		await provider.removeWork('work-0001', {});
		// @ts-expect-error the options object itself is required — never defaulted, never inverted
		await provider.removeWork('work-0001');
		// @ts-expect-error `boolean`, not `undefined`: "not said" is not a decision the zone can act on
		await provider.removeWork('work-0001', { deleteData: undefined });

		// The positive control: the boolean the caller chose is the boolean the zone
		// receives — APW-06's `deleteVolumes` is passed through, never coerced
		// (plan §5.2:609).
		removeWorkCalls.length = 0;
		await provider.removeWork('work-0001', { deleteData: false });
		await provider.removeWork('work-0002', { deleteData: true });
		expect(removeWorkCalls).toEqual([
			{ workId: 'work-0001', deleteData: false },
			{ workId: 'work-0002', deleteData: true }
		]);
	});

	it('answers every read with the plan’s shape', async () => {
		await expect(provider.zoneInfo()).resolves.toEqual(zoneInfo);
		await expect(provider.applyWork(workSpec)).resolves.toEqual({ generation: workSpec.generation });
		await expect(provider.getWork('work-0001')).resolves.toEqual(workStatus);
		await expect(provider.getWork('work-0001')).resolves.not.toBeNull();
		await expect(provider.getSelfCheck('run-0001')).resolves.toEqual(selfCheck);
		await expect(provider.reviewCredentialScope()).resolves.toEqual(accessReview);
		await expect(provider.getHeartbeat()).resolves.toEqual(heartbeat);
		await expect(provider.listUsageReports(500)).resolves.toEqual([usageReport]);
		await expect(provider.listAbuseSignals(200)).resolves.toEqual([abuseSignal]);
		await expect(provider.getDependencies('work-0001')).resolves.toEqual(dependencyStatuses);
		await expect(provider.releaseDependencies('work-0001', { deleteData: true })).resolves.toEqual({
			remaining: []
		});

		// `null` means "no such object", never "I could not tell" (plan §5.1:552, :579).
		await expect(minimalProvider.getWork('work-0001')).resolves.toBeNull();
		await expect(minimalProvider.getSelfCheck('run-0001')).resolves.toBeNull();
	});

	it('is a plugin, and the tier’s plugin is a deployment plugin', () => {
		const asPlugin: IPlugin = provider;
		expect(asPlugin.category).toBe('deployment');
		expect(asPlugin.capabilities).toContain(PLUGIN_CAPABILITIES.APPS_TIER);
		expect(asPlugin.capabilities).toContain(PLUGIN_CAPABILITIES.DEPLOYMENT);
		expect(isPluginCategory(asPlugin.category)).toBe(true);
		for (const capability of asPlugin.capabilities) {
			expect(isValidPluginCapability(capability), capability).toBe(true);
		}
	});

	it('is reachable through the contracts barrel the package publishes', () => {
		// `contracts/index.ts` re-exports `capabilities/index.ts`, which is the path
		// `@ever-works/plugin/contracts` serves: a module that is not on that path is
		// a capability no consumer can import.
		expect(contractsBarrel.APPS_TIER_LOG_UNAVAILABLE_CODE).toBe(APPS_TIER_LOG_UNAVAILABLE_CODE);
		expect(contractsBarrel.APPS_TIER_SELF_CHECK_PHASES).toEqual([...APPS_TIER_SELF_CHECK_PHASES]);
		const fromBarrel: IAppsTierProvider = provider;
		expect(fromBarrel.id).toBe('ever-works-apps');
	});
});

/* ─────────────── the shapes apps-tier.types.ts declares (plan §3.1–§3.6) ─────────────── */

describe('the types the apps-tier contract names (APW-10 T2)', () => {
	it('projects the zone info ConfigMap with all five fields', () => {
		// §5.1:550's trailing comment names three; §3.6:427 is the object, and it
		// carries five. A field renamed out of this list fails here, and a sixth
		// field added without the plan fails the key comparison.
		expect(Object.keys(zoneInfo)).toEqual([
			'appsDomain',
			'sandboxRuntimeClass',
			'registryHost',
			'edgeIngressClass',
			'minPlatformVersion'
		]);
		// None is optional: a zone that cannot say where its apps live is a zone
		// the tier must not be opened against.
		for (const [field, value] of Object.entries(zoneInfo)) {
			expect(typeof value, field).toBe('string');
			expect(value.length, field).toBeGreaterThan(0);
		}
	});

	it('reports a self-check run with the plan’s phases and T1’s result rows', () => {
		expect(APPS_TIER_SELF_CHECK_PHASES).toEqual(['Running', 'Completed', 'Failed']);
		expect(new Set(APPS_TIER_SELF_CHECK_PHASES).size).toBe(APPS_TIER_SELF_CHECK_PHASES.length);
		expect(Object.keys(selfCheck)).toEqual([
			'phase',
			'startedAt',
			'finishedAt',
			'results',
			'policyRevision',
			'controllerVersion'
		]);
		// A run in flight has no finish time; a finished one does.
		const running: AppsTierSelfCheckStatus = { ...selfCheck, phase: 'Running', finishedAt: null, results: [] };
		expect(running.finishedAt).toBeNull();
		// @ts-expect-error `Running` is not a phase this contract carries — the union is closed
		const invented: AppsTierSelfCheckStatus = { ...selfCheck, phase: 'Pending' };
		expect(invented.phase).toBe('Pending');
		// The rows are T1's own declaration, not a copy: each is assignable both ways.
		const row: AppsTierSelfCheckResult = selfCheck.results[0];
		expect(row.id).toBe('LG-02');
	});

	it('carries the heartbeat as a Date, and both nulls as findings', () => {
		// §5.1:581 writes `renewedAt: Date | null` — a `Date`, not an ISO string,
		// because `evaluate()` compares it against HEARTBEAT_MAX_AGE_MS.
		expect(heartbeat.renewedAt).toBeInstanceOf(Date);
		const silent: AppsTierHeartbeat = { renewedAt: null, controllerVersion: null };
		expect(silent.renewedAt).toBeNull();
		expect(silent.controllerVersion).toBeNull();
	});

	it('carries one field per billable usage unit — in both directions', async () => {
		// The five housekeeping fields of §3.2 are the object's own identity; every
		// other field must be one of T1's `APPS_TIER_USAGE_UNITS`, and every unit T1
		// names must have a field. A unit the pricebook bills but the report never
		// carries would be metered as zero, silently.
		const housekeeping = ['name', 'workId', 'windowStart', 'windowEnd', 'acknowledgedAt'];
		const metered = Object.keys(usageReport).filter((field) => !housekeeping.includes(field));
		expect(metered.slice().sort()).toEqual([...APPS_TIER_USAGE_UNITS].slice().sort());
		for (const unit of APPS_TIER_USAGE_UNITS) {
			expect(Object.keys(usageReport), unit).toContain(unit);
			expect(typeof usageReport[unit], unit).toBe('number');
		}
		// The name is the handle `acknowledgeUsageReports` takes, and the §3.2
		// pattern is `ur-<workId>-<windowStart epoch>`.
		expect(usageReport.name.startsWith(`ur-${usageReport.workId}-`)).toBe(true);
		expect(usageReport.acknowledgedAt).toBeNull();
	});

	it('reports an abuse signal inside T1’s closed sets and the summary cap', () => {
		expect(APPS_TIER_SIGNAL_KINDS).toContain(abuseSignal.kind);
		expect(APPS_TIER_SIGNAL_SEVERITIES).toContain(abuseSignal.severity);
		expect(abuseSignal.summary.length).toBeLessThanOrEqual(APPS_TIER_SIGNAL_SUMMARY_MAX_CHARS);
		expect(abuseSignal.test).toBe(false);
		expect(abuseSignal.autoQuarantined).toBe(true);
		expect(Object.keys(abuseSignal)).toEqual([
			'name',
			'workId',
			'kind',
			'severity',
			'observedAt',
			'summary',
			'ruleId',
			'test',
			'acknowledgedAt',
			'autoQuarantined'
		]);
		// @ts-expect-error `mining` and its siblings are the closed set; `crypto` is not a kind
		const invented: AppsTierAbuseSignalReport = { ...abuseSignal, kind: 'crypto' };
		expect(APPS_TIER_SIGNAL_KINDS).not.toContain(invented.kind as string);
	});

	it('answers a log pull with either a redacted tail or the one refusal code', async () => {
		expect(APPS_TIER_LOG_UNAVAILABLE_CODE).toBe('logs_unavailable_on_tier');
		// A ready page carries no code, and a refused page carries nothing else.
		expect(readyLogPage.status).toBe('ready');
		expect(readyLogPage.code).toBeNull();
		expect(readyLogPage.tail?.redactedNames).toEqual(['EXAMPLE_VALUE']);
		expect(unavailableLogPage.status).toBe('unavailable');
		expect(unavailableLogPage.tail).toBeNull();
		expect(unavailableLogPage.code).toBe(APPS_TIER_LOG_UNAVAILABLE_CODE);
		// The request is APW-06's own `AppLogRequest`, aliased: the same fields, and
		// the secret values travel in memory only (plan §5.2:621).
		await expect(provider.getAppLogs('work-0001', logRequest)).resolves.toEqual(readyLogPage);
		await expect(provider.getAppLogs('work-0001', { ...logRequest, component: 'worker' })).resolves.toEqual(
			unavailableLogPage
		);
	});

	it('reuses APW-05’s scan and signature vocabulary for build status', () => {
		expect(APP_BUILD_SIGNATURE_STATES).toContain(buildStatus.signatureState);
		expect(Object.keys(buildStatus.scanSummary ?? {})).toEqual([
			'critical',
			'high',
			'medium',
			'low',
			'fixableCritical'
		]);
		expect(buildStatus.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		// `phase` is the zone's own word — the plan leaves it untyped, so this
		// contract must not narrow it to a union of the values seen today.
		const capExceeded: AppsTierBuildStatus = { ...buildStatus, phase: 'capExceeded', finishedAt: null };
		expect(capExceeded.phase).toBe('capExceeded');
		expect(typeof capExceeded.phase).toBe('string');
	});

	it('re-exports T1’s Work model rather than restating it (R-1)', async () => {
		// A re-export is the same declaration: both directions assign, so the plugin
		// contract cannot drift from `packages/contracts`.
		const asWorkSpec: ContractsWorkSpec = workSpec;
		const backToWorkSpec: AppsTierWorkSpec = asWorkSpec;
		expect(backToWorkSpec).toEqual(workSpec);

		const asDependencyRef: ContractsDependencyRef = dependencyRefs[0];
		const backToDependencyRef: AppsTierDependencyRef = asDependencyRef;
		expect(backToDependencyRef).toEqual({ kind: 'postgres', ref: 'dep-postgres' });

		// Plan §5.1:551 writes `applyWork(input: AppsTierWorkDesiredState)`; that
		// identifier is T1's four-value `spec.desiredState` union, and the whole
		// object `applyWork` takes is `AppsTierWorkSpec`. Both are reachable here,
		// and they are different names for different things.
		const desiredState: AppsTierWorkDesiredState = 'quarantined';
		expect(APPS_TIER_WORK_DESIRED_STATES).toContain(desiredState);
		expect(workSpec.desiredState).toBe('running');
		expect(Object.keys(workSpec)).toContain('desiredState');
		// `setDesiredState` carries only the two states a transition may move
		// between — never `removed` (that is `removeWork`) and never `paused`.
		await expect(provider.setDesiredState('work-0001', 'quarantined', quarantineRequest)).resolves.toBeUndefined();
		// @ts-expect-error `removed` is a `desiredState` but not a `setDesiredState` transition
		await provider.setDesiredState('work-0001', 'removed');
	});

	it('reports dependencies with the four phases and the release gate', async () => {
		expect(dependencyStatuses.map((entry) => entry.phase)).toEqual(['ready', 'pending']);
		for (const entry of dependencyStatuses) {
			expect(['pending', 'ready', 'failed', 'released']).toContain(entry.phase);
		}
		// `lastBackupAt: null` means "no backup to report", never "backed up now".
		expect(dependencyStatuses[1].lastBackupAt).toBeNull();
		// Only `deleteData` — the dependency deprovision decision is explicit here
		// too, because it is the App's data (plan §2.6:207–208).
		// @ts-expect-error `deleteData` is required on releaseDependencies as well
		await provider.releaseDependencies('work-0001', {});
	});
});
