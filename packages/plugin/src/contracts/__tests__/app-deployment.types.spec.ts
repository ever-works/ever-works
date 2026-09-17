/**
 * APW-06 T2 — the App-deployment plugin contract.
 *
 * Two kinds of assertion live here:
 *
 * 1. **Type-level** (the point of the task). A plugin that implements only the
 *    members `IDeploymentPlugin` had before APW-06 — and, one rung at a time,
 *    each later group of App members — must still satisfy the interface. That
 *    is the additive-only proof (CONTRACTS R-26) expressed in the type system:
 *    if any App member were made required, the `satisfies` clauses and the
 *    `IsOptional<…>` assertions below stop compiling.
 * 2. **Behavioural** — `isAppDeploymentPlugin` and its false cases.
 *
 * NOTE ON HOW THESE BIND: `packages/plugin/tsconfig.json` includes `src/**` but
 * excludes spec files (`*.spec.ts` at any depth), so
 * `pnpm --filter @ever-works/plugin type-check` (`tsc --noEmit`) does not
 * compile this file, and `pnpm test` runs it through esbuild, which erases
 * types. The type-level pins therefore bind when this file is type-checked
 * directly, e.g.
 *
 *     packages/plugin/node_modules/.bin/tsc --noEmit --strict --module ESNext \
 *       --moduleResolution bundler --target ES2021 --skipLibCheck \
 *       --esModuleInterop src/contracts/__tests__/app-deployment.types.spec.ts
 *
 * The runtime assertions in every block bind under `pnpm test` as well.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
	isAppDeploymentPlugin,
	isDeploymentPlugin,
	type DeploymentConfig,
	type DeploymentLookupContext,
	type DeploymentResult,
	type IDeploymentPlugin
} from '../capabilities/deployment.interface.js';
import type {
	AppClusterCheck,
	AppComponentInput,
	AppComponentStatus,
	AppCronInput,
	AppDeployHooks,
	AppDeployPhase,
	AppDeployResult,
	AppDeployTarget,
	AppDestroyResult,
	AppFailureCode,
	AppJobInput,
	AppJobResult,
	AppJobRunRequest,
	AppLimitRangeInput,
	AppLogRef,
	AppLogRequest,
	AppLogTail,
	AppQuotaInput,
	AppRenderInput,
	AppRuntimeState,
	AppScaleResult,
	AppSmokeInput,
	AppSmokeResult,
	AppSmokeRun,
	AppStatusSnapshot,
	AppStatusSpec,
	AppTargetRef,
	CheckResult
} from '../capabilities/app-deployment.types.js';
// Proves the barrel chain: package root -> contracts -> capabilities -> this module.
import type { AppDeployTarget as BarrelAppDeployTarget } from '../../index.js';

/**
 * `true` when `T[K]` may be omitted. Making any App member required flips this
 * to `false`, and the `toEqualTypeOf<true>()` assertion under it stops
 * compiling — that is the pin the whole file exists for.
 */
type IsOptional<T, K extends keyof T> = undefined extends T[K] ? true : false;

/* -------------------------------------------------------------------------- */
/* Fixtures — one rung per group of members, so each group stays optional.     */
/* -------------------------------------------------------------------------- */

/** The three members `IDeploymentPlugin` required before APW-06 (plus `IPlugin`). */
function preExistingMembers(): Pick<IDeploymentPlugin, 'providerName' | 'deploy' | 'getDeploymentStatus'> {
	return {
		providerName: 'placeholder-provider',
		async deploy(_config: DeploymentConfig, _token: string): Promise<DeploymentResult> {
			return { id: 'deployment-1', status: 'ready', createdAt: '2026-01-01T00:00:00.000Z' };
		},
		async getDeploymentStatus(_deploymentId: string, _token: string): Promise<DeploymentResult> {
			return { id: 'deployment-1', status: 'ready', createdAt: '2026-01-01T00:00:00.000Z' };
		}
	};
}

/** The five App members of CONTRACTS §3, row "`IDeploymentPlugin` App additions". */
function firstFiveAppMembers(): Pick<
	IDeploymentPlugin,
	'supportsApps' | 'deployApp' | 'getAppStatus' | 'runAppJob' | 'destroyApp'
> {
	return {
		supportsApps: true,
		async deployApp(_input: AppRenderInput, _credential: string, _hooks: AppDeployHooks): Promise<AppDeployResult> {
			return {
				outcome: 'succeeded',
				warnings: [],
				components: [],
				jobs: [],
				smoke: { inCluster: [], public: [], observedAt: '2026-01-01T00:00:00.000Z' },
				ingressAddress: null,
				isolationEnforced: true,
				firstDeployJobsCompleted: true
			};
		},
		async getAppStatus(): Promise<AppStatusSnapshot> {
			return {
				observedAt: '2026-01-01T00:00:00.000Z',
				components: [],
				jobs: [],
				cron: [],
				isolationEnforced: true
			};
		},
		async runAppJob(): Promise<AppJobResult> {
			return {
				name: 'bootstrap-admin',
				when: 'first-deploy',
				runName: 'run-00000000',
				status: 'succeeded',
				startedAt: '2026-01-01T00:00:00.000Z'
			};
		},
		async destroyApp(): Promise<AppDestroyResult> {
			return { deleted: [], kept: [], namespaceDeleted: true };
		}
	};
}

/** The three App members added by CONTRACTS §3, row "… (added by APW-06, all optional)". */
function threeMoreAppMembers(): Pick<IDeploymentPlugin, 'scaleApp' | 'getAppLogs' | 'checkAppCluster'> {
	return {
		async scaleApp(
			_ref: AppTargetRef,
			_credential: string,
			_mode: 'pause' | 'resume',
			_replicas: Record<string, number>,
			_resumeChecks?: { smoke: AppSmokeInput[]; deadlines: Record<string, number> }
		): Promise<AppScaleResult> {
			return { components: [], smoke: null };
		},
		async getAppLogs(): Promise<AppLogTail> {
			return { containers: [], redactedNames: [], fetchedAt: '2026-01-01T00:00:00.000Z' };
		},
		async checkAppCluster(): Promise<AppClusterCheck> {
			return {
				ok: true,
				fingerprint: 'placeholder-fingerprint',
				missingPermissions: [],
				optionalMissing: [],
				ingressClasses: [],
				controllerNamespace: null,
				clusterIssuers: [],
				storageClasses: []
			};
		}
	};
}

/** The two newest App members (`prepareAppNamespace`, `publishAppHosts`). */
function twoNewestAppMembers(): Pick<IDeploymentPlugin, 'prepareAppNamespace' | 'publishAppHosts'> {
	return {
		async prepareAppNamespace(): Promise<{ warnings: Array<{ code: string; message: string }> }> {
			return { warnings: [] };
		},
		async publishAppHosts(): Promise<{ ingressAddress: { ip?: string; hostname?: string } | null }> {
			return { ingressAddress: null };
		}
	};
}

/**
 * Rung 1 — a plugin that implements ONLY the pre-existing members. This is what
 * today's `k8s` and Vercel plugins look like. If ANY App member were required,
 * this literal would stop satisfying `IDeploymentPlugin`.
 */
const pluginWithPreExistingMembersOnly = {
	id: 'rung-1-pre-existing',
	name: 'Rung 1 — pre-existing members only',
	version: '0.0.0-test',
	category: 'deployment',
	capabilities: ['deployment'],
	settingsSchema: { type: 'object', properties: {} },
	async onLoad(): Promise<void> {},
	async onUnload(): Promise<void> {},
	...preExistingMembers()
} satisfies IDeploymentPlugin;

/** Rung 2 — pre-existing members + the first five App members. */
const pluginWithFirstFiveAppMembers = {
	id: 'rung-2-first-five',
	name: 'Rung 2 — first five App members',
	version: '0.0.0-test',
	category: 'deployment',
	capabilities: ['deployment'],
	settingsSchema: { type: 'object', properties: {} },
	async onLoad(): Promise<void> {},
	async onUnload(): Promise<void> {},
	...preExistingMembers(),
	...firstFiveAppMembers()
} satisfies IDeploymentPlugin;

/**
 * Rung 3 — pre-existing members + the **eight earlier App members**. If the two
 * newer members (`prepareAppNamespace`, `publishAppHosts`) were required, this
 * literal would stop satisfying `IDeploymentPlugin`.
 */
const pluginWithEightEarlierAppMembers = {
	id: 'rung-3-eight-earlier',
	name: 'Rung 3 — eight earlier App members',
	version: '0.0.0-test',
	category: 'deployment',
	capabilities: ['deployment'],
	settingsSchema: { type: 'object', properties: {} },
	async onLoad(): Promise<void> {},
	async onUnload(): Promise<void> {},
	...preExistingMembers(),
	...firstFiveAppMembers(),
	...threeMoreAppMembers()
} satisfies IDeploymentPlugin;

/** Rung 4 — every App member (a full App deployment provider). */
const pluginWithAllAppMembers = {
	id: 'rung-4-all',
	name: 'Rung 4 — every App member',
	version: '0.0.0-test',
	category: 'deployment',
	capabilities: ['deployment', 'apps-tier'],
	settingsSchema: { type: 'object', properties: {} },
	async onLoad(): Promise<void> {},
	async onUnload(): Promise<void> {},
	...preExistingMembers(),
	...firstFiveAppMembers(),
	...threeMoreAppMembers(),
	...twoNewestAppMembers()
} satisfies IDeploymentPlugin;

/** `supportsApps: true` with no `deployApp` — the second false case of the guard. */
const pluginWithSupportsAppsButNoDeployApp = {
	...pluginWithPreExistingMembersOnly,
	supportsApps: true
} satisfies IDeploymentPlugin;

/** `deployApp` present but `supportsApps: false` — an opt-out, not a provider. */
const pluginWithSupportsAppsFalse = {
	...pluginWithPreExistingMembersOnly,
	...firstFiveAppMembers(),
	supportsApps: false
} satisfies IDeploymentPlugin;

/** `deployApp` present and `supportsApps` absent — the third false case. */
const pluginWithDeployAppButNoSupportsApps = {
	...pluginWithPreExistingMembersOnly,
	deployApp: firstFiveAppMembers().deployApp
} satisfies IDeploymentPlugin;

/* -------------------------------------------------------------------------- */

describe('IDeploymentPlugin — the ten App members are all OPTIONAL (R-26)', () => {
	it('rung 1: a plugin with only the pre-existing members satisfies IDeploymentPlugin', () => {
		// The `satisfies` above is the assertion; this is its runtime shadow.
		expect('supportsApps' in pluginWithPreExistingMembersOnly).toBe(false);
		expect('deployApp' in pluginWithPreExistingMembersOnly).toBe(false);
		expect('getAppStatus' in pluginWithPreExistingMembersOnly).toBe(false);
		expect('runAppJob' in pluginWithPreExistingMembersOnly).toBe(false);
		expect('destroyApp' in pluginWithPreExistingMembersOnly).toBe(false);
		expect('scaleApp' in pluginWithPreExistingMembersOnly).toBe(false);
		expect('getAppLogs' in pluginWithPreExistingMembersOnly).toBe(false);
		expect('checkAppCluster' in pluginWithPreExistingMembersOnly).toBe(false);
		expect('prepareAppNamespace' in pluginWithPreExistingMembersOnly).toBe(false);
		expect('publishAppHosts' in pluginWithPreExistingMembersOnly).toBe(false);
	});

	it('rung 3: a plugin with only the eight earlier App members satisfies IDeploymentPlugin', () => {
		expect('supportsApps' in pluginWithEightEarlierAppMembers).toBe(true);
		expect('checkAppCluster' in pluginWithEightEarlierAppMembers).toBe(true);
		expect('prepareAppNamespace' in pluginWithEightEarlierAppMembers).toBe(false);
		expect('publishAppHosts' in pluginWithEightEarlierAppMembers).toBe(false);
	});

	it('supportsApps is optional', () => {
		expectTypeOf<IsOptional<IDeploymentPlugin, 'supportsApps'>>().toEqualTypeOf<true>();
	});

	it('deployApp is optional', () => {
		expectTypeOf<IsOptional<IDeploymentPlugin, 'deployApp'>>().toEqualTypeOf<true>();
	});

	it('getAppStatus is optional', () => {
		expectTypeOf<IsOptional<IDeploymentPlugin, 'getAppStatus'>>().toEqualTypeOf<true>();
	});

	it('runAppJob is optional', () => {
		expectTypeOf<IsOptional<IDeploymentPlugin, 'runAppJob'>>().toEqualTypeOf<true>();
	});

	it('destroyApp is optional', () => {
		expectTypeOf<IsOptional<IDeploymentPlugin, 'destroyApp'>>().toEqualTypeOf<true>();
	});

	it('scaleApp is optional', () => {
		expectTypeOf<IsOptional<IDeploymentPlugin, 'scaleApp'>>().toEqualTypeOf<true>();
	});

	it('getAppLogs is optional', () => {
		expectTypeOf<IsOptional<IDeploymentPlugin, 'getAppLogs'>>().toEqualTypeOf<true>();
	});

	it('checkAppCluster is optional', () => {
		expectTypeOf<IsOptional<IDeploymentPlugin, 'checkAppCluster'>>().toEqualTypeOf<true>();
	});

	it('prepareAppNamespace is optional', () => {
		expectTypeOf<IsOptional<IDeploymentPlugin, 'prepareAppNamespace'>>().toEqualTypeOf<true>();
	});

	it('publishAppHosts is optional', () => {
		expectTypeOf<IsOptional<IDeploymentPlugin, 'publishAppHosts'>>().toEqualTypeOf<true>();
	});

	it('the pre-existing members keep their signatures', () => {
		expectTypeOf<IDeploymentPlugin['providerName']>().toEqualTypeOf<string>();
		expectTypeOf<IDeploymentPlugin['deploy']>().toEqualTypeOf<
			(config: DeploymentConfig, token: string) => Promise<DeploymentResult>
		>();
		expectTypeOf<IDeploymentPlugin['getDeploymentStatus']>().toEqualTypeOf<
			(deploymentId: string, token: string, context?: DeploymentLookupContext) => Promise<DeploymentResult>
		>();
	});

	it('deployApp keeps its (input, credential, hooks) signature', () => {
		type DeployApp = NonNullable<IDeploymentPlugin['deployApp']>;
		expectTypeOf<Parameters<DeployApp>[0]>().toEqualTypeOf<AppRenderInput>();
		expectTypeOf<Parameters<DeployApp>[1]>().toEqualTypeOf<string>();
		expectTypeOf<Parameters<DeployApp>[2]>().toEqualTypeOf<AppDeployHooks>();
		expectTypeOf<ReturnType<DeployApp>>().toEqualTypeOf<Promise<AppDeployResult>>();
	});

	it('scaleApp returns Promise<AppScaleResult> and takes an optional resumeChecks argument', () => {
		type ScaleApp = NonNullable<IDeploymentPlugin['scaleApp']>;
		expectTypeOf<Parameters<ScaleApp>[0]>().toEqualTypeOf<AppTargetRef>();
		expectTypeOf<Parameters<ScaleApp>[1]>().toEqualTypeOf<string>();
		expectTypeOf<Parameters<ScaleApp>[2]>().toEqualTypeOf<'pause' | 'resume'>();
		expectTypeOf<Parameters<ScaleApp>[3]>().toEqualTypeOf<Record<string, number>>();
		expectTypeOf<Parameters<ScaleApp>[4]>().toEqualTypeOf<
			{ smoke: AppSmokeInput[]; deadlines: Record<string, number> } | undefined
		>();
		expectTypeOf<ReturnType<ScaleApp>>().toEqualTypeOf<Promise<AppScaleResult>>();
	});

	it('the remaining App members keep their signatures', () => {
		type GetAppStatus = NonNullable<IDeploymentPlugin['getAppStatus']>;
		type RunAppJob = NonNullable<IDeploymentPlugin['runAppJob']>;
		type DestroyApp = NonNullable<IDeploymentPlugin['destroyApp']>;
		type GetAppLogs = NonNullable<IDeploymentPlugin['getAppLogs']>;
		type CheckAppCluster = NonNullable<IDeploymentPlugin['checkAppCluster']>;
		type PrepareAppNamespace = NonNullable<IDeploymentPlugin['prepareAppNamespace']>;
		type PublishAppHosts = NonNullable<IDeploymentPlugin['publishAppHosts']>;

		expectTypeOf<Parameters<GetAppStatus>[2]>().toEqualTypeOf<AppStatusSpec>();
		expectTypeOf<ReturnType<GetAppStatus>>().toEqualTypeOf<Promise<AppStatusSnapshot>>();

		expectTypeOf<Parameters<RunAppJob>[2]>().toEqualTypeOf<AppJobRunRequest>();
		expectTypeOf<ReturnType<RunAppJob>>().toEqualTypeOf<Promise<AppJobResult>>();

		expectTypeOf<Parameters<DestroyApp>[2]>().toEqualTypeOf<{ deleteVolumes: boolean }>();
		expectTypeOf<ReturnType<DestroyApp>>().toEqualTypeOf<Promise<AppDestroyResult>>();

		expectTypeOf<Parameters<GetAppLogs>[2]>().toEqualTypeOf<AppLogRequest>();
		expectTypeOf<ReturnType<GetAppLogs>>().toEqualTypeOf<Promise<AppLogTail>>();

		expectTypeOf<Parameters<CheckAppCluster>[0]>().toEqualTypeOf<string>();
		expectTypeOf<ReturnType<CheckAppCluster>>().toEqualTypeOf<Promise<AppClusterCheck>>();

		expectTypeOf<Parameters<PrepareAppNamespace>[2]>().toEqualTypeOf<{
			isolation: boolean;
			limitRange: AppLimitRangeInput;
		}>();
		expectTypeOf<ReturnType<PrepareAppNamespace>>().toEqualTypeOf<
			Promise<{ warnings: Array<{ code: string; message: string }> }>
		>();

		expectTypeOf<Parameters<PublishAppHosts>[2]>().toEqualTypeOf<{
			primary: string | null;
			extra: string[];
			previous: string[];
			tls: string;
			issuer: string | null;
		}>();
		expectTypeOf<ReturnType<PublishAppHosts>>().toEqualTypeOf<
			Promise<{ ingressAddress: { ip?: string; hostname?: string } | null }>
		>();
	});
});

describe('isAppDeploymentPlugin — the guard', () => {
	it('is true for a plugin that declares supportsApps and implements deployApp', () => {
		expect(isAppDeploymentPlugin(pluginWithAllAppMembers)).toBe(true);
		expect(isAppDeploymentPlugin(pluginWithEightEarlierAppMembers)).toBe(true);
		expect(isAppDeploymentPlugin(pluginWithFirstFiveAppMembers)).toBe(true);

		const plugin: IDeploymentPlugin = pluginWithAllAppMembers;
		if (isAppDeploymentPlugin(plugin)) {
			// Narrowing: both members are non-optional after the guard.
			expectTypeOf(plugin.supportsApps).toEqualTypeOf<true>();
			expectTypeOf(plugin.deployApp).toBeFunction();
		}
	});

	it('is false when supportsApps is absent', () => {
		expect(isAppDeploymentPlugin(pluginWithPreExistingMembersOnly)).toBe(false);
		expect(isAppDeploymentPlugin(pluginWithDeployAppButNoSupportsApps)).toBe(false);
	});

	it('is false when supportsApps is true but deployApp is missing', () => {
		expect(isAppDeploymentPlugin(pluginWithSupportsAppsButNoDeployApp)).toBe(false);
	});

	it('is false when supportsApps is false even though deployApp is implemented', () => {
		expect(isAppDeploymentPlugin(pluginWithSupportsAppsFalse)).toBe(false);
	});

	it('does not consult capabilities — a deployment plugin with no capabilities still qualifies', () => {
		const noCapabilities: IDeploymentPlugin = { ...pluginWithAllAppMembers, capabilities: [] };
		expect(isDeploymentPlugin(noCapabilities)).toBe(false);
		expect(isAppDeploymentPlugin(noCapabilities)).toBe(true);
	});

	it('isDeploymentPlugin still narrows on the pre-existing capability string', () => {
		expect(isDeploymentPlugin(pluginWithPreExistingMembersOnly)).toBe(true);
	});
});

describe('app-deployment.types — the shape APW-04 / APW-10 / APW-13 compile against', () => {
	it('the package barrel re-exports the new module', () => {
		expectTypeOf<BarrelAppDeployTarget>().toEqualTypeOf<AppDeployTarget>();
	});

	it('AppDeployTarget is the three chosen targets (R-12 / R-27), never a "not yet" value', () => {
		expectTypeOf<AppDeployTarget>().toEqualTypeOf<'none' | 'your-cluster' | 'ever-works-apps'>();
	});

	it('AppRuntimeState is the seven states FR-46 reports', () => {
		expectTypeOf<AppRuntimeState>().toEqualTypeOf<
			'not-deployed' | 'live' | 'degraded' | 'down' | 'unreachable' | 'paused' | 'deleting'
		>();
	});

	it('AppDeployPhase is the phase machine of plan §5.5', () => {
		expectTypeOf<AppDeployPhase>().toEqualTypeOf<
			| 'prepare'
			| 'pre-deploy-jobs'
			| 'rollout'
			| 'first-deploy-jobs'
			| 'in-cluster-smoke'
			| 'publish'
			| 'public-smoke'
			| 'post-deploy-jobs'
			| 'cron'
			| 'rollback'
			| 'done'
		>();
	});

	it('AppFailureCode is exactly the 18 codes of plan §3.1', () => {
		expectTypeOf<AppFailureCode>().toEqualTypeOf<
			| 'crash_loop'
			| 'oom_killed'
			| 'image_pull'
			| 'create_container_config'
			| 'rollout_timeout'
			| 'job_failed'
			| 'smoke_failed'
			| 'publish_failed'
			| 'rollback_failed'
			| 'cluster_unreachable'
			| 'worker_failed'
			| 'isolation_not_enforced'
			| 'managed_root_forbidden'
			| 'image_user_unverifiable'
			| 'deadline_exceeded'
			| 'image_not_found'
			| 'image_private_unsupported'
			| 'image_unresolvable'
		>();
	});

	it('AppRenderInput carries purpose and ttlMinutes', () => {
		expectTypeOf<AppRenderInput['purpose']>().toEqualTypeOf<'deploy' | 'verification' | undefined>();
		expectTypeOf<AppRenderInput['ttlMinutes']>().toEqualTypeOf<number | undefined>();
		expectTypeOf<AppRenderInput['ref']>().toEqualTypeOf<AppTargetRef>();
	});

	it('AppJobInput carries http.authScheme', () => {
		type JobHttp = NonNullable<AppJobInput['http']>;
		expectTypeOf<JobHttp['authScheme']>().toEqualTypeOf<'bearer' | 'raw' | undefined>();
		expectTypeOf<JobHttp['authEnv']>().toEqualTypeOf<string | undefined>();
		expectTypeOf<AppJobInput['when']>().toEqualTypeOf<'pre-deploy' | 'first-deploy' | 'post-deploy'>();
		expectTypeOf<AppJobInput['component']>().toEqualTypeOf<string>();
	});

	it('AppCronInput is the unresolved App spec block (plan §3.1)', () => {
		expectTypeOf<AppCronInput['component']>().toEqualTypeOf<string | undefined>();
		expectTypeOf<AppCronInput['concurrency']>().toEqualTypeOf<'forbid' | 'allow' | undefined>();
		expectTypeOf<AppCronInput['timeoutSeconds']>().toEqualTypeOf<number | undefined>();
	});

	it('AppSmokeInput resolves name and component', () => {
		expectTypeOf<AppSmokeInput['name']>().toEqualTypeOf<string>();
		expectTypeOf<AppSmokeInput['component']>().toEqualTypeOf<string>();
		expectTypeOf<AppSmokeInput['when']>().toEqualTypeOf<'always' | 'first-deploy' | undefined>();
	});

	it('AppComponentInput resolves the spec defaults and adds primary / deadlineSeconds / internalUrl', () => {
		expectTypeOf<AppComponentInput['replicas']>().toEqualTypeOf<number>();
		expectTypeOf<AppComponentInput['writableRootFilesystem']>().toEqualTypeOf<boolean>();
		expectTypeOf<AppComponentInput['primary']>().toEqualTypeOf<boolean>();
		expectTypeOf<AppComponentInput['deadlineSeconds']>().toEqualTypeOf<number>();
		expectTypeOf<AppComponentInput['internalUrl']>().toEqualTypeOf<string>();
		expectTypeOf<AppComponentInput['role']>().toEqualTypeOf<'web' | 'worker'>();
	});

	it('AppQuotaInput carries the 13 keys of plan §4.2', () => {
		expectTypeOf<keyof AppQuotaInput>().toEqualTypeOf<
			| 'requests.cpu'
			| 'limits.cpu'
			| 'requests.memory'
			| 'limits.memory'
			| 'pods'
			| 'persistentvolumeclaims'
			| 'requests.storage'
			| 'services.loadbalancers'
			| 'services.nodeports'
			| 'count/jobs.batch'
			| 'count/cronjobs.batch'
			| 'secrets'
			| 'configmaps'
		>();
	});

	it('AppDeployResult carries cancelReason, image and the isolation verdict', () => {
		expectTypeOf<AppDeployResult['cancelReason']>().toEqualTypeOf<
			'user' | 'quarantined' | 'app_work_deleting' | undefined
		>();
		expectTypeOf<AppDeployResult['image']>().toEqualTypeOf<
			{ readonly reference: string; readonly digest: string; readonly resolvedFromTag: boolean } | undefined
		>();
		expectTypeOf<AppDeployResult['isolationEnforced']>().toEqualTypeOf<boolean | null>();
	});

	it('AppDestroyResult carries kept', () => {
		expectTypeOf<AppDestroyResult['kept']>().toEqualTypeOf<
			readonly { readonly kind: string; readonly name: string }[]
		>();
		expectTypeOf<AppDestroyResult['namespaceDeleted']>().toEqualTypeOf<boolean>();
	});

	it('AppJobRunRequest carries the runner: "smoke" variant', () => {
		expectTypeOf<AppJobRunRequest['runner']>().toEqualTypeOf<'smoke' | undefined>();
		expectTypeOf<AppJobRunRequest['checks']>().toEqualTypeOf<readonly AppSmokeInput[] | undefined>();
	});

	it('the log tail carries the FR-48 shape', () => {
		expectTypeOf<AppLogTail['containers']>().toEqualTypeOf<
			readonly {
				readonly pod: string;
				readonly container: string;
				readonly lines: readonly string[];
				readonly truncated: boolean;
			}[]
		>();
		expectTypeOf<AppLogRequest['lines']>().toEqualTypeOf<number>();
		expectTypeOf<AppLogRef['previous']>().toEqualTypeOf<boolean>();
	});

	it('AppStatusSnapshot is one persisted observation', () => {
		expectTypeOf<AppStatusSnapshot['isolationEnforced']>().toEqualTypeOf<boolean | null>();
		expectTypeOf<AppStatusSnapshot['smoke']>().toEqualTypeOf<AppSmokeResult | undefined>();
		expectTypeOf<AppStatusSpec['jobs']>().toEqualTypeOf<readonly string[]>();
	});

	it('the smoke / job / component result shapes agree', () => {
		expectTypeOf<AppSmokeRun['checks']>().toEqualTypeOf<readonly CheckResult[]>();
		expectTypeOf<AppComponentStatus['role']>().toEqualTypeOf<'web' | 'worker'>();
		expectTypeOf<AppJobResult['status']>().toEqualTypeOf<'succeeded' | 'failed' | 'timeout' | 'running'>();
		expectTypeOf<AppScaleResult['smoke']>().toEqualTypeOf<AppSmokeRun | null>();
	});
});
