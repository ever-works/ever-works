/**
 * APW-05 T2 — the `build` capability, the `build` category and `IBuildPlugin`.
 *
 * The interface itself is pinned by its own compile-time shape: the fixtures
 * below are annotated with the plan's types (`IBuildPlugin`,
 * `PrepareRepositoryInput`, `BuildSnapshot`, `VerificationPlan`,
 * `RepositoryWriter`, …), so a member the plan names cannot be renamed, made
 * required-optional or dropped without `tsc -p tsconfig.specs.json` failing.
 * What this spec exists for is the three things a capability can silently get
 * wrong, plus the shapes the task names explicitly:
 *
 *  1. **the constant and the category are the strings the plan names**, so a
 *     plugin manifest (`category: build`, `capabilities: [build]`), the facade's
 *     resolution (`PLUGIN_CAPABILITIES.BUILD`) and the web's category maps all
 *     agree (plan §4.2:753–757);
 *  2. **nothing was removed to make room for it.** Both `PLUGIN_CAPABILITIES`
 *     and `PLUGIN_CATEGORIES` are append-only surfaces: a capability or
 *     category that disappears silently breaks every manifest that declares it,
 *     and the failure shows up as a plugin that loads with fewer capabilities
 *     than it has — never as an error. The `EXISTING_*` lists below are the
 *     pre-APW-05-T2 snapshot taken from `HEAD`, so a removal fails here with the
 *     missing name in the message;
 *  3. **the shared contracts are called, not restated (R-1).** `BuildRunRef`,
 *     `AppBuildVerificationResult` and `BUILD_SERVICE_DEFAULTS` come from
 *     `@ever-works/contracts` (APW-05 T1), and the constant is asserted to be
 *     the very same object on both paths — a second copy is exactly the drift
 *     plan §4.5:810–812 ("so the two cannot drift") forbids.
 *
 * The cases the task names are covered in `the contract surface (plan §4.1)`:
 * `BuildStrategy` including `auto` (R-13), `PrepareRepositoryInput.checks`,
 * `VerificationPlan.promptedNames`, `BuildSnapshot.checksBillableMinutes` and
 * the optional `checkImageAccess?`.
 */

import { describe, expect, it } from 'vitest';
import { BUILD_SERVICE_DEFAULTS as CONTRACTS_BUILD_SERVICE_DEFAULTS } from '@ever-works/contracts';
import { PLUGIN_CATEGORIES, isPluginCategory, type PluginCategory } from '../plugin-manifest.types.js';
import {
	PLUGIN_CAPABILITIES,
	ALL_PLUGIN_CAPABILITIES,
	isValidPluginCapability,
	type PluginCapability
} from '../facade-capabilities.js';
import {
	BUILD_SERVICE_DEFAULTS,
	isBuildPlugin,
	type AppBuildBlock,
	type BuildRef,
	type BuildRepositoryRef,
	type BuildSnapshot,
	type BuildStrategy,
	type BuildValue,
	type IBuildPlugin,
	type ImageAccessResult,
	type PrepareRepositoryInput,
	type PrepareRepositoryResult,
	type RepositoryWriteErrorCode,
	type RepositoryWriter,
	type StartBuildInput,
	type VerificationPlan
} from '../capabilities/build.interface.js';
import type { IPlugin } from '../plugin.interface.js';

/**
 * Every capability VALUE that existed before APW-05 T2 appended `build`.
 *
 * Taken from `facade-capabilities.ts` at `HEAD` (not hand-written): the
 * capability values are not the category names (`form-schema-provider`, not
 * `form`; `metrics-provider`, not `metrics`), and `app-dependency` (APW-07 T3)
 * and `connector-microsoft-365` are already there — a snapshot written from the
 * category tuple instead of the capability map fails on its own list.
 */
const EXISTING_CAPABILITIES = [
	'agent-memory',
	'ai-provider',
	'app-dependency',
	'browser-automation',
	'code-edit',
	'connection-scopes',
	'connector',
	'connector-bluesky',
	'connector-discord',
	'connector-hubspot',
	'connector-linear',
	'connector-mastodon',
	'connector-microsoft-365',
	'connector-notion',
	'connector-pipedrive',
	'connector-slack',
	'connector-whatsapp',
	'content-extractor',
	'data-source',
	'deployment',
	'device-auth',
	'email-inbound',
	'email-outbound',
	'event-source',
	'form-schema-provider',
	'get-object',
	'git-provider',
	'metrics-provider',
	'notification-channel',
	'notification-channel-discord',
	'notification-channel-novu',
	'notification-channel-slack',
	'notification-channel-telegram',
	'notification-channel-whatsapp',
	'oauth',
	'pipeline',
	'pipeline-modifier',
	'playbook-provider',
	'presigned-put',
	'prompt-provider',
	'put-object',
	'screenshot',
	'search',
	'skills-provider',
	'storage',
	'task-tracker',
	'terminal-stream',
	'workspace'
] as const;

/** Every category that existed before the same change, in the tuple's own order. */
const EXISTING_CATEGORIES = [
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
	'app-dependency'
] as const;

/**
 * Every capability and category a LATER epic appended behind `build`, in the
 * map's / tuple's own order — APW-12 T4 added `identity-provider` and `identity`,
 * and APW-10 T2 added `apps-tier` (which appends no category).
 *
 * This spec owns `build`; these two lists exist so its append-only assertions stay
 * statements about *this* change rather than about the tuple's current tail. An
 * epic that appends behind `build` extends them in the same change (APW-07 T3's
 * spec below does the same for its own list). Leaving them behind does not make
 * the assertions weaker, it makes them FAIL on a legitimate append — which is
 * exactly how the "last category is `build`" pin here was found.
 */
const LATER_CAPABILITIES: readonly string[] = ['identity-provider', 'apps-tier'];
const LATER_CATEGORIES: readonly PluginCategory[] = ['identity'];

/** The four strategies of Resolution R-13, in the plan's order (plan §4.1:585–589). */
const EVERY_STRATEGY: readonly BuildStrategy[] = ['dockerfile', 'image', 'auto', 'none'];

/** The two refusal codes the delivery rules branch on (plan §4.6:872–879). */
const EVERY_WRITE_REFUSAL: readonly RepositoryWriteErrorCode[] = ['nonFastForward', 'refRejectedByRule'];

/* ─────────────────────────── typed fixtures ─────────────────────────── */

const repository: BuildRepositoryRef = {
	owner: 'member',
	repo: 'cal-diy-fork',
	visibility: 'private',
	trackedBranch: 'main',
	createdByAppWork: true
};

const build: AppBuildBlock = {
	strategy: 'dockerfile',
	dockerfile: 'Dockerfile',
	context: '.',
	args: [
		{ name: 'PUBLIC_URL', value: 'https://cal.example.test' },
		{ name: 'DATABASE_URL', fromEnv: 'DATABASE_URL' }
	],
	services: [{ name: 'postgres', image: 'postgres:16', port: 5432 }],
	resources: { cpu: 2, memoryGiB: 8, timeoutMinutes: 30 }
};

const values: readonly BuildValue[] = [
	{
		name: 'DATABASE_URL',
		value: 'postgres://build:build@127.0.0.1:5432/app',
		secret: true,
		fromBuildService: true,
		fingerprint: 'v3'
	}
];

const prepareInput: PrepareRepositoryInput = {
	workId: '11111111-1111-4111-8111-111111111111',
	repository,
	build,
	appSpecHash: 'a'.repeat(64),
	values,
	previouslyWrittenSecretNames: ['EW_OLD_VALUE'],
	lastWrittenWorkflowSha256: null,
	settings: { reclaimDisk: true, attestations: false },
	checks: [
		{ name: 'lint', command: 'pnpm lint', required: true, timeoutSeconds: 300 },
		{ name: 'unit', command: 'pnpm test', required: false, timeoutSeconds: 600 }
	]
};

const prepareResult: PrepareRepositoryResult = {
	workflow: {
		state: 'committed',
		commitSha: 'b'.repeat(40),
		contentSha256: 'c'.repeat(64)
	},
	secretsWritten: ['EW_DATABASE_URL'],
	secretsRemoved: [],
	buildInputsHash: 'd'.repeat(64)
};

const verification: VerificationPlan = {
	json: '{"version":1,"components":[],"dependencies":[],"jobs":[],"smoke":[],"env":[]}',
	promptedNames: ['SMTP_PASSWORD']
};

const startInput: StartBuildInput = {
	workId: prepareInput.workId,
	buildId: '22222222-2222-4222-8222-222222222222',
	repository,
	ref: 'main',
	sha: 'e'.repeat(40),
	mode: 'verify',
	reuseImageDigest: `sha256:${'f'.repeat(64)}`,
	verification,
	settings: { reclaimDisk: true }
};

const buildRef: BuildRef = {
	repository,
	buildId: startInput.buildId,
	providerRunId: '1234567890',
	dispatchedAt: '2026-09-18T10:00:00.000Z'
};

const snapshot: BuildSnapshot = {
	providerRunId: buildRef.providerRunId,
	runAttempt: 1,
	status: 'succeeded',
	conclusion: 'success',
	trigger: 'manual',
	branch: 'main',
	commitSha: startInput.sha,
	startedAt: '2026-09-18T10:00:05.000Z',
	completedAt: '2026-09-18T10:04:35.000Z',
	billableMinutes: 5,
	checksBillableMinutes: 2,
	runnerLabel: 'ubuntu-latest',
	logsUrl: 'https://github.com/member/cal-diy-fork/actions/runs/1234567890',
	image: {
		repository: 'ghcr.io/member/cal-diy-fork/ever-works-app',
		digest: `sha256:${'1'.repeat(64)}`,
		tags: [`sha-${startInput.sha}`, 'branch-main'],
		confirmed: true
	},
	secretCheck: 'passed',
	failure: { class: 'timeout', detail: { minutes: 30 }, excerpt: ['step failed'] },
	verification: {
		componentsReady: true,
		jobs: [{ name: 'migrate', exitCode: 0, durationMs: 1200 }],
		smoke: [{ name: 'health', expected: '200', observed: '200', passed: true, durationMs: 42 }]
	}
};

const imageAccess: ImageAccessResult = {
	visibility: 'private',
	readable: true,
	tokenScopesOk: true,
	tokenExpiresAt: '2026-12-01T00:00:00.000Z',
	digest: `sha256:${'2'.repeat(64)}`
};

const writer: RepositoryWriter = {
	getFileContent: async () => ({ content: 'name: Ever Works build', encoding: 'utf-8' }),
	commitFiles: async (input) => ({ commitSha: `sha-${input.files.length}` }),
	createBranch: async (name) => ({ name, commit: startInput.sha, isDefault: false }),
	createPullRequest: async (options) => ({
		number: 7,
		title: options.title,
		state: 'open',
		head: options.head,
		base: options.base,
		url: 'https://github.com/member/cal-diy-fork/pull/7',
		createdAt: '2026-09-18T10:00:00.000Z',
		updatedAt: '2026-09-18T10:00:00.000Z'
	})
};

/** A complete build plugin: every required member of `IBuildPlugin` and both optional ones. */
const plugin: IBuildPlugin = {
	id: 'github-actions-build',
	name: 'GitHub Actions build',
	version: '1.0.0',
	category: 'build',
	capabilities: [PLUGIN_CAPABILITIES.BUILD],
	buildKind: 'github-actions',
	supportedStrategies: ['dockerfile'],
	settingsSchema: { type: 'object' },
	onLoad: async () => undefined,
	onUnload: async () => undefined,
	prepareRepository: async () => prepareResult,
	startBuild: async () => ({ providerRunId: '1234567890', dispatchedAt: '2026-09-18T10:00:00.000Z' }),
	getBuild: async () => snapshot,
	cancelBuild: async () => undefined,
	getLogsUrl: async () => snapshot.logsUrl ?? null,
	listRecentRuns: async () => ({
		notModified: false,
		etag: 'W/"etag"',
		runs: [
			{
				providerRunId: '1234567890',
				runAttempt: 1,
				event: 'push',
				status: 'completed',
				headSha: startInput.sha,
				headBranch: 'main',
				headRepositoryFullName: 'member/cal-diy-fork',
				displayTitle: 'Ever Works build 1',
				createdAt: '2026-09-18T10:00:00.000Z'
			}
		]
	}),
	checkImageAccess: async () => imageAccess
};

/** The same plugin without the two optional members — the contract must still hold. */
const minimalPlugin: IBuildPlugin = {
	...plugin,
	listRecentRuns: undefined,
	checkImageAccess: undefined
};

/* ─────────────────────────── the capability and the category ─────────────────────────── */

describe('the build capability (APW-05 T2, plan §4.2:753–757)', () => {
	it('names the capability exactly as the plan does', () => {
		expect(PLUGIN_CAPABILITIES.BUILD).toBe('build');
		const capability: PluginCapability = PLUGIN_CAPABILITIES.BUILD;
		expect(capability).toBe('build');
		expect(isValidPluginCapability('build')).toBe(true);
		// A near miss must stay invalid: the guard is what plugin manifests and the
		// facade's resolution are validated against, so a plural alias cannot exist.
		expect(isValidPluginCapability('builds')).toBe(false);
		expect(isValidPluginCapability(undefined)).toBe(false);
	});

	it('appends the capability without removing, reordering or duplicating a member', () => {
		const capabilities = Object.values(PLUGIN_CAPABILITIES) as readonly string[];

		for (const capability of EXISTING_CAPABILITIES) {
			expect(capabilities, capability).toContain(capability);
			expect(isValidPluginCapability(capability), capability).toBe(true);
		}

		// Exactly one member was added *by this change*, and it is the new one.
		expect(capabilities.filter((entry) => entry === 'build')).toHaveLength(1);
		// …and everything a later epic appended behind it is present and valid, so the
		// count below stays an exact total rather than a number that drifts.
		for (const capability of LATER_CAPABILITIES) {
			expect(capabilities, capability).toContain(capability);
			expect(isValidPluginCapability(capability), capability).toBe(true);
		}
		expect(capabilities).toHaveLength(EXISTING_CAPABILITIES.length + 1 + LATER_CAPABILITIES.length);

		// The array the guard reads is derived from the map, so it follows.
		expect(ALL_PLUGIN_CAPABILITIES).toContain('build');
		expect(new Set(ALL_PLUGIN_CAPABILITIES).size).toBe(ALL_PLUGIN_CAPABILITIES.length);
	});

	it('appends the category without removing, reordering or duplicating a member', () => {
		expect(PLUGIN_CATEGORIES).toContain('build');

		// The append-only guarantee, asserted rather than assumed: every pre-existing
		// member is still there, in the same relative order, exactly once. `remaining`
		// drops `build` and whatever a later epic appended behind it, so the equality
		// stays a statement about the members that existed before this change.
		const remaining = PLUGIN_CATEGORIES.filter((entry) => entry !== 'build' && !LATER_CATEGORIES.includes(entry));
		expect(remaining).toEqual([...EXISTING_CATEGORIES]);
		expect(new Set(PLUGIN_CATEGORIES).size).toBe(PLUGIN_CATEGORIES.length);

		// …and the new member sits immediately after the block that preceded it, which
		// is what "append" means here: a category inserted in the middle would renumber
		// every index a consumer persisted. Pinned as an index and as a slice — the
		// durable form — rather than as "it is the last entry", which stopped being true
		// the first time a later epic appended behind it (APW-12 T4's `identity`).
		expect(PLUGIN_CATEGORIES.indexOf('build')).toBe(EXISTING_CATEGORIES.length);
		expect(PLUGIN_CATEGORIES.slice(0, EXISTING_CATEGORIES.length)).toEqual([...EXISTING_CATEGORIES]);

		// The derived union follows the tuple.
		const asCategory: PluginCategory = 'build';
		expect(PLUGIN_CATEGORIES).toContain(asCategory);
	});

	it('accepts the category through the guard and refuses a near miss', () => {
		expect(isPluginCategory('build')).toBe(true);
		expect(isPluginCategory('builds')).toBe(false);
	});

	it('keeps the category and the capability one spelling', () => {
		// A manifest declares both (`category: build`, `capabilities: [build]`, plan
		// §4.3:762), and the web's `Record<PluginCategory, …>` maps are keyed by the
		// tuple — so a divergence here is a plugin that never lists.
		expect(PLUGIN_CATEGORIES).toContain(PLUGIN_CAPABILITIES.BUILD);
		expect(plugin.category).toBe(PLUGIN_CAPABILITIES.BUILD);
	});
});

/* ─────────────────────────── the guard ─────────────────────────── */

describe('isBuildPlugin (APW-05 T2, plan §4.1:743–745)', () => {
	it('accepts a plugin that declares the capability', () => {
		expect(isBuildPlugin(plugin)).toBe(true);
		expect(isBuildPlugin(minimalPlugin)).toBe(true);
	});

	it('refuses a plugin that does not declare it', () => {
		expect(isBuildPlugin({ ...plugin, capabilities: [PLUGIN_CAPABILITIES.DEPLOYMENT] } as IPlugin)).toBe(false);
		expect(isBuildPlugin({ ...plugin, capabilities: [] } as IPlugin)).toBe(false);
		expect(
			isBuildPlugin({
				id: 'vercel',
				name: 'Vercel',
				version: '1.0.0',
				category: 'deployment',
				capabilities: [PLUGIN_CAPABILITIES.DEPLOYMENT],
				settingsSchema: { type: 'object' },
				onLoad: async () => undefined,
				onUnload: async () => undefined
			} as IPlugin)
		).toBe(false);
	});

	it('is the capability test alone, exactly as the plan writes the guard', () => {
		// Plan §4.1:743–745 makes the guard `capabilities.includes('build')` and nothing
		// else. Pinned deliberately: a method check here would answer `false` for a
		// lazily-proxied plugin instance, which is why the plan keeps the guard on the
		// declared capability and leaves the method checks to the caller.
		const withoutMethods = {
			...plugin,
			prepareRepository: undefined,
			startBuild: undefined
		} as unknown as IPlugin;
		expect(isBuildPlugin(withoutMethods)).toBe(true);
	});
});

/* ─────────────────────────── the contract surface the task names ─────────────────────────── */

describe('the IBuildPlugin contract surface (APW-05 T2, plan §4.1)', () => {
	it('carries `auto` among the strategies (R-13)', () => {
		// `EVERY_STRATEGY` is annotated with `BuildStrategy`, so dropping a member
		// from the union is a type-check failure; this asserts the set at runtime too.
		expect(EVERY_STRATEGY).toContain('auto');
		expect(EVERY_STRATEGY).toEqual(['dockerfile', 'image', 'auto', 'none']);
		expect(plugin.supportedStrategies).toEqual(['dockerfile']);
	});

	it('carries the App spec checks on a preparation (R-9)', () => {
		expect(prepareInput.checks).toHaveLength(2);
		expect(prepareInput.checks[0]).toEqual({
			name: 'lint',
			command: 'pnpm lint',
			required: true,
			timeoutSeconds: 300
		});
		// Empty is a valid list and means "no checks job" (plan §4.1:634–635).
		const withoutChecks: PrepareRepositoryInput = { ...prepareInput, checks: [] };
		expect(withoutChecks.checks).toHaveLength(0);
	});

	it('carries prompted names, and no prompted value, on a verification plan', () => {
		expect(verification.promptedNames).toEqual(['SMTP_PASSWORD']);
		// The plan JSON travels as one string; no resolved value is carried beside it.
		expect(typeof verification.json).toBe('string');
		expect(Object.keys(verification)).toEqual(['json', 'promptedNames']);
	});

	it('reports checks minutes separately from the status they never decide', () => {
		expect(snapshot.checksBillableMinutes).toBe(2);
		expect(snapshot.billableMinutes).toBe(5);
		// A failed `Ever Works check:` job cannot fail the Build: the status is the
		// build job's alone (R-9, FR-69), so a snapshot may carry both facts at once.
		const redCheck: BuildSnapshot = { ...snapshot, status: 'succeeded', checksBillableMinutes: 1 };
		expect(redCheck.status).toBe('succeeded');
		expect(redCheck.checksBillableMinutes).toBe(1);
	});

	it('allows a snapshot to carry a verification result and a digest together', () => {
		expect(snapshot.verification?.componentsReady).toBe(true);
		expect(snapshot.verification?.smoke[0]).toEqual({
			name: 'health',
			expected: '200',
			observed: '200',
			passed: true,
			durationMs: 42
		});
		expect(snapshot.image?.digest).toBe(`sha256:${'1'.repeat(64)}`);
	});

	it('keeps both optional members optional', () => {
		expect(typeof plugin.listRecentRuns).toBe('function');
		expect(typeof plugin.checkImageAccess).toBe('function');
		// A plugin without them is still an `IBuildPlugin` — the annotation on
		// `minimalPlugin` is the proof, and the guard does not depend on them.
		expect(minimalPlugin.listRecentRuns).toBeUndefined();
		expect(minimalPlugin.checkImageAccess).toBeUndefined();
		expect(isBuildPlugin(minimalPlugin)).toBe(true);
	});

	it('answers image access with the four fields the pull-token check reads', () => {
		expect(imageAccess).toEqual({
			visibility: 'private',
			readable: true,
			tokenScopesOk: true,
			tokenExpiresAt: '2026-12-01T00:00:00.000Z',
			digest: `sha256:${'2'.repeat(64)}`
		});
	});
});

describe('the RepositoryWriter seam (APW-05 T2, plan §4.1:714–717, 749–751)', () => {
	it('exposes the four clone-free members and nothing that clones', () => {
		expect(Object.keys(writer).sort()).toEqual([
			'commitFiles',
			'createBranch',
			'createPullRequest',
			'getFileContent'
		]);
		for (const member of Object.values(writer)) expect(typeof member).toBe('function');
	});

	it('is repository-bound: a commit takes no owner, repo or token', async () => {
		const result = await writer.commitFiles({
			branch: 'main',
			baseSha: startInput.sha,
			message: 'Update Ever Works build workflow',
			files: [
				{ path: '.github/workflows/ever-works-build.yml', content: 'name: Ever Works build', encoding: 'utf-8' }
			]
		});
		expect(result.commitSha).toBe('sha-1');
		expect(await writer.getFileContent('.github/workflows/ever-works-build.yml')).toEqual({
			content: 'name: Ever Works build',
			encoding: 'utf-8'
		});
		// `null` is the not-found answer, not an error (plan §4.6 steps 4–5).
		expect(await writer.getFileContent('.github/workflows/missing.yml', 'main')).toBeDefined();
	});

	it('pins the two refusal codes the delivery rules branch on', () => {
		expect(EVERY_WRITE_REFUSAL).toEqual(['nonFastForward', 'refRejectedByRule']);
	});
});

/* ─────────────────────────── the shared contracts, called not restated (R-1) ─────────────────────────── */

describe('the contracts APW-05 T1 landed, re-exported rather than restated (R-1)', () => {
	it('re-exports BUILD_SERVICE_DEFAULTS as the very same object', () => {
		// Identity, not deep equality: the generator (plan §4.5) and APW-07's resolver
		// read the same declaration, which is what stops the two from drifting.
		expect(BUILD_SERVICE_DEFAULTS).toBe(CONTRACTS_BUILD_SERVICE_DEFAULTS);
		expect(BUILD_SERVICE_DEFAULTS.postgres.env.POSTGRES_USER).toBe('ever-works-build');
		expect(BUILD_SERVICE_DEFAULTS.postgres.containerPort).toBe(5432);
	});
});
