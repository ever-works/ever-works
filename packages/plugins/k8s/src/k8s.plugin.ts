import type {
	AddDomainResult,
	AppClusterCheckRequest,
	AppDeployHooks,
	AppDeployResult,
	AppDependencyBackupStatus,
	AppDependencyContext,
	AppDependencyDeprovisionOptions,
	AppDependencyDeprovisionOutcome,
	AppDependencyKind,
	AppDependencyProviderDescriptor,
	AppDependencyProvisionOutcome,
	AppDependencySupport,
	AppDependencyTarget,
	AppDestroyResult,
	AppJobResult,
	AppJobRunRequest,
	AppLimitRangeInput,
	AppLogRequest,
	AppLogTail,
	AppRenderInput,
	AppScaleResult,
	AppSmokeInput,
	AppStatusSnapshot,
	AppStatusSpec,
	AppTargetRef,
	ConnectionValidationResult,
	DeploymentConfig,
	DeploymentDomain,
	DeploymentLookupContext,
	DeploymentProject,
	DeploymentResult,
	IDeploymentPlugin,
	IPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	ValidationError,
	ValidationResult
} from '@ever-works/plugin';

import { createHash } from 'node:crypto';

import { K8sPluginError, buildSecretPattern, scrubError } from './errors.js';
import { KubernetesApiService } from './k8s-api.service.js';
import { defaultIngressStrategyRegistry, IngressStrategyRegistry } from './ingress/strategy.registry.js';
import { defaultRegistryProviderRegistry, RegistryProviderRegistry } from './registries/provider.registry.js';
import { mapDeploymentToStatus } from './status.mapper.js';
import {
	buildDeployment,
	buildRuntimeEnvSecret,
	buildImagePullSecret,
	buildIngress,
	buildService,
	pullSecretNameFor
} from './manifest.renderer.js';
import { parseKubeconfig } from './kubeconfig.parser.js';
// APW-07 T19 — the in-cluster App dependencies. The plugin is the wiring: it publishes the descriptors and
// delegates each of the five contract methods to the provider that owns the behaviour, exactly as the App
// runtime members above delegate to `AppDeployer` / `AppLifecycle` / `AppStatusReader`.
import { APP_DEPENDENCY_SIZE_DEFAULTS } from './app-dependencies/common.js';
// APW-07 T21 — the S3-compatible object store.
import {
	OBJECT_STORAGE_PROVIDER_DESCRIPTOR,
	OBJECT_STORAGE_PROVIDER_ID,
	ObjectStorageDependencyProvider
} from './app-dependencies/object-storage.provider.js';
import {
	POSTGRES_PROVIDER_DESCRIPTOR,
	POSTGRES_PROVIDER_ID,
	PostgresDependencyProvider
} from './app-dependencies/postgres.provider.js';
// APW-07 T20 — the single-replica cache.
import {
	REDIS_PROVIDER_DESCRIPTOR,
	REDIS_PROVIDER_ID,
	RedisDependencyProvider
} from './app-dependencies/redis.provider.js';
import {
	appendHostToIngress,
	buildDnsGuidance,
	defaultDnsResolver,
	removeHostFromIngress,
	verifyDomainResolution,
	type DnsResolver
} from './domain.handler.js';
// The App runtime (APW-06 T14). The plugin is the wiring: §6.1's guard runs over every credential
// here, once, and each method then delegates to the module that owns the behaviour — `AppDeployer`
// (T12), `AppStatusReader` / `AppLifecycle` (T13) and `AppClusterChecker` (T13).
import { AppClusterChecker } from './app/app-cluster-check.js';
import { AppDeployer } from './app/app-deployer.js';
import { AppLifecycle } from './app/app-lifecycle.js';
import { AppStatusReader } from './app/app-status.reader.js';
// §4.12's verification expiry annotation — the one name, taken from `app-names.ts` rather
// than restated here.
import { APP_ANNOTATION_EXPIRES_AT } from './app/app-names.js';
import {
	assertSupportedKubeconfig,
	CLUSTER_PRIVATE_ALLOWLIST_ENV,
	pinKubeconfigServer,
	readClusterPrivateAllowlist
} from './app/app-kubeconfig.guard.js';
import type { AppClusterCheckReport } from './app/app-cluster-check.js';
import type { KubeconfigDnsResolver } from './app/app-kubeconfig.guard.js';
import type {
	ClusterNodeDescriptor,
	ClusterSource,
	IngressClassDescriptor,
	KubernetesSettings,
	RegistryConfig,
	RegistryDeployContext,
	ResolvedImageVisibility
} from './types.js';

const VALID_CLUSTER_SOURCES: readonly ClusterSource[] = ['k8s-works-shared', 'k8s-works', 'custom-kubeconfig'];

/**
 * The three in-cluster dependency providers this plugin publishes — APW-07 T19, T20 and T21.
 *
 * They share one structural shape: `descriptor` plus the four contract methods (`supports`, `provision`,
 * `getOutputs`, `deprovision`, `backupStatus`), so the delegation below is written once against the union
 * rather than three times against three classes. A provider that stopped answering one of them would be a
 * compile error here rather than a `undefined is not a function` at the first dependency of that kind.
 */
type AppDependencyK8sProvider = PostgresDependencyProvider | RedisDependencyProvider | ObjectStorageDependencyProvider;

function isClusterSource(value: unknown): value is ClusterSource {
	return typeof value === 'string' && (VALID_CLUSTER_SOURCES as readonly string[]).includes(value);
}

function hashRuntimeEnv(env: Record<string, string>): string {
	// Rolls the pods when the runtime env genuinely changes (rotated secret,
	// new host) and leaves them alone when it does not. Not a security
	// boundary — just a change detector — but sha256 keeps it collision-free.
	const canonical = Object.keys(env)
		.sort()
		.map((key) => `${key}=${env[key]}`)
		.join('\n');
	return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

const DEFAULT_NAMESPACE = 'ever-works';
const DEFAULT_REPLICAS = 1;
const CONTAINER_PORT = 3000;
const DEFAULT_MEMORY_REQUEST = '512Mi';
const DEFAULT_MEMORY_LIMIT = '2Gi';

interface ParsedQuantity {
	numerator: bigint;
	denominator: bigint;
}

const MANAGED_MEMORY_REQUEST_MINIMUM = parseKubernetesQuantity(DEFAULT_MEMORY_REQUEST)!;

function isPlatformManagedClusterSource(source: ClusterSource | undefined): boolean {
	return source === 'k8s-works' || source === 'k8s-works-shared';
}

/**
 * Parse Kubernetes' DecimalSI, BinarySI, and DecimalExponent quantity forms
 * into an exact rational number. Custom clusters keep passing their strings
 * through untouched; this parser is only used to enforce managed-cluster
 * memory invariants before an API write.
 */
function parseKubernetesQuantity(value: unknown): ParsedQuantity | undefined {
	if (typeof value !== 'string') return undefined;
	const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:(?:[eE]([+-]?\d+))|(Ki|Mi|Gi|Ti|Pi|Ei|[numkMGTPE]))?$/.exec(
		value
	);
	if (!match) return undefined;

	const integer = match[2] ?? '0';
	const fraction = match[3] ?? match[4] ?? '';
	let numerator = BigInt(`${integer}${fraction}` || '0');
	let denominator = 10n ** BigInt(fraction.length);
	if (match[1] === '-') numerator = -numerator;

	const exponentText = match[5];
	const suffix = match[6] ?? '';
	if (exponentText !== undefined) {
		const exponent = Number(exponentText);
		// Kubernetes resources are bounded far below this; the guard prevents
		// an adversarial settings string from allocating an enormous BigInt.
		if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return undefined;
		if (exponent >= 0) numerator *= 10n ** BigInt(exponent);
		else denominator *= 10n ** BigInt(-exponent);
	}

	const decimalPowers: Record<string, number> = {
		n: -9,
		u: -6,
		m: -3,
		'': 0,
		k: 3,
		M: 6,
		G: 9,
		T: 12,
		P: 15,
		E: 18
	};
	const binaryPowers: Record<string, number> = { Ki: 10, Mi: 20, Gi: 30, Ti: 40, Pi: 50, Ei: 60 };

	if (suffix in binaryPowers) {
		numerator *= 1n << BigInt(binaryPowers[suffix]);
	} else {
		const power = decimalPowers[suffix];
		if (power === undefined) return undefined;
		if (power >= 0) numerator *= 10n ** BigInt(power);
		else denominator *= 10n ** BigInt(-power);
	}

	return { numerator, denominator };
}

function compareQuantities(left: ParsedQuantity, right: ParsedQuantity): number {
	const leftScaled = left.numerator * right.denominator;
	const rightScaled = right.numerator * left.denominator;
	return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

function effectiveMemorySizing(settings: KubernetesSettings): {
	memoryRequest: string | undefined;
	memoryLimit: string | undefined;
} {
	if (!isPlatformManagedClusterSource(settings.clusterSource)) {
		return { memoryRequest: settings.memoryRequest, memoryLimit: settings.memoryLimit };
	}

	const requested = settings.memoryRequest ?? DEFAULT_MEMORY_REQUEST;
	const limited = settings.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
	const requestQuantity = parseKubernetesQuantity(requested);
	const limitQuantity = parseKubernetesQuantity(limited);
	if (requestQuantity === undefined || limitQuantity === undefined) {
		throw new K8sPluginError(
			'UNKNOWN',
			'Managed Kubernetes memory request and limit must use valid Kubernetes resource quantities.'
		);
	}

	const belowFloor = compareQuantities(requestQuantity, MANAGED_MEMORY_REQUEST_MINIMUM) < 0;
	const memoryRequest = belowFloor ? DEFAULT_MEMORY_REQUEST : requested;
	const effectiveRequestQuantity = belowFloor ? MANAGED_MEMORY_REQUEST_MINIMUM : requestQuantity;
	if (compareQuantities(limitQuantity, effectiveRequestQuantity) < 0) {
		throw new K8sPluginError(
			'UNKNOWN',
			'Managed Kubernetes memory limit must cover the effective request (the 512Mi admission floor or a larger configured request).'
		);
	}

	return { memoryRequest, memoryLimit: limited };
}

interface DeployOptions {
	/** Short git SHA (or any deterministic version tag). */
	gitSha?: string;
	/** GitHub owner login when registry.kind === 'github' and owner field is empty. */
	githubOwner?: string;
	/** Whether the website repo is private. Used to resolve `visibility: 'auto'`. */
	websiteRepoIsPrivate?: boolean;
	/** GitHub token for read:packages access (private images only). */
	githubReadPackagesToken?: string;
	/** Custom hosts to add as Ingress rules (in addition to settings.ingressHost). */
	hosts?: string[];
	/**
	 * Server-side (platform-managed) deploys — overrides for values the
	 * GitHub Actions path derived inside the workflow:
	 *
	 * `namespaceOverride` — the namespace the platform ENFORCED server-side
	 * (per-tenant override + reserved-namespace blocklist). Without it this
	 * method would fall back to the plugin's own persisted settings, i.e.
	 * whatever free-text the user typed.
	 *
	 * `imageName` — the image repository name when it differs from the work
	 * slug. CI (k8s-build.yml) pushes `ghcr.io/<owner>/<WEBSITE-REPO>:<tag>`,
	 * so the platform passes the website repo name here; manifest names and
	 * labels keep using `projectName` (the work slug).
	 *
	 * `runtimeEnv` — key→value map applied as the `<slug>-runtime-env`
	 * Opaque Secret and `envFrom`'d into the container. Replaces the
	 * workflow's toJSON(secrets) copy step; values never touch the repo.
	 */
	namespaceOverride?: string;
	/** `null` selects the effective kubeconfig's current context. */
	kubeContextOverride?: string | null;
	imageName?: string;
	runtimeEnv?: Record<string, string>;
	/**
	 * Work-scoped plugin settings, layered over the ones this plugin loads for
	 * itself. The singleton's PluginContext is built WITHOUT a user/work scope
	 * (createContext takes only a pluginId), so `getSettings()` resolves
	 * admin -> env -> schema default and silently discards everything the Work
	 * configured — replicas would clamp to 1, a per-Work registry override
	 * would be ignored, kubeContext dropped. The caller has the scoped values.
	 */
	settingsOverride?: Record<string, unknown>;
	/** Escape hatch for side-loaded images (kind e2e). Production leaves this unset -> 'Always'. */
	imagePullPolicy?: 'Always' | 'IfNotPresent' | 'Never';
	/** Full commit SHA — used only as a pod annotation to force a rollout, never as the image tag. */
	revision?: string;
}

const REGISTRY_SCHEMA: JsonSchema = {
	type: 'object',
	title: 'Container registry',
	default: { kind: 'github' },
	oneOf: [
		{
			type: 'object',
			title: 'GitHub Container Registry (default)',
			properties: {
				kind: { type: 'string', const: 'github' },
				owner: {
					type: 'string',
					title: 'GitHub owner',
					description: 'Defaults to your connected GitHub account.'
				},
				visibility: {
					type: 'string',
					enum: ['auto', 'public', 'private'],
					default: 'auto',
					title: 'Image visibility',
					description:
						'auto = match the website repo (public repo → public image, private repo → private image).'
				}
			},
			required: ['kind']
		},
		{
			type: 'object',
			title: 'Docker Hub',
			properties: {
				kind: { type: 'string', const: 'dockerhub' },
				username: { type: 'string', title: 'Docker Hub username' },
				password: {
					type: 'string',
					title: 'Access token',
					'x-secret': true,
					'x-scope': 'user',
					'x-widget': 'password'
				}
			},
			required: ['kind', 'username', 'password']
		},
		{
			type: 'object',
			title: 'Generic registry',
			properties: {
				kind: { type: 'string', const: 'generic' },
				server: {
					type: 'string',
					title: 'Server URL',
					description: 'e.g. registry.example.com'
				},
				username: { type: 'string', title: 'Username' },
				password: {
					type: 'string',
					title: 'Password',
					'x-secret': true,
					'x-scope': 'user',
					'x-widget': 'password'
				}
			},
			required: ['kind', 'server', 'username', 'password']
		}
	]
};

export class KubernetesPlugin implements IPlugin, IDeploymentPlugin {
	readonly id = 'k8s';
	readonly name = 'Kubernetes';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'deployment';
	/**
	 * APW-07 T19 (plan §4.9:570): the plugin answers for App dependencies as well as deployments. Appended,
	 * never replaced — `'deployment'` is what every pre-existing routing decision in the platform selects on.
	 */
	readonly capabilities: readonly string[] = ['deployment', 'app-dependency'];
	readonly providerName = 'kubernetes';

	/**
	 * This plugin implements APW-06's App members (below), so `isAppDeploymentPlugin` narrows it and
	 * the runtime target resolver may route `your-cluster` App Work operations here. It deliberately
	 * does **not** serve `ever-works-apps`: on the managed tier the platform never applies manifests
	 * (R-5) — APW-10's `apps-tier` plugin reconciles a `Work` resource in-zone from the same renderer.
	 */
	readonly supportsApps = true;

	/**
	 * APW-07 T19/T20/T21 — the dependency providers this plugin answers for (plan §4.9:570, §4.9:617-618).
	 *
	 * All three in-cluster providers, and the AppDependencyFacadeService orders the whole set by
	 * `preference` — which is why the list is a `readonly` array of descriptors rather than three named fields.
	 */
	readonly dependencyProviders: readonly AppDependencyProviderDescriptor[] = [
		POSTGRES_PROVIDER_DESCRIPTOR,
		REDIS_PROVIDER_DESCRIPTOR,
		OBJECT_STORAGE_PROVIDER_DESCRIPTOR
	];

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			clusterSource: {
				type: 'string',
				// `k8s-works-shared` (shared customer cluster) is listed first as the
				// customer default. `k8s-works` (internal cluster) is admin-only and is
				// hidden from non-admins by the `k8s-cluster-source` widget + the
				// server-side deploy gate; it stays in the enum so platform admins can
				// still persist it (schema validation must accept it). `default` stays
				// `custom-kubeconfig` so pre-existing Works with a pasted kubeconfig and
				// no explicit clusterSource keep deploying exactly as before.
				enum: ['k8s-works-shared', 'k8s-works', 'custom-kubeconfig'],
				default: 'custom-kubeconfig',
				title: 'Target cluster',
				// Non-admin-safe copy (no mention of the admin-only `k8s-works`). The
				// `k8s-cluster-source` widget renders the full admin copy for platform
				// admins. Keep these two in sync with the owner-provided wording.
				description:
					"Where to deploy. 'k8s-works-shared' = Ever Works shared customer cluster. 'custom-kubeconfig' = paste your own kubeconfig below. Allowed values depend on the GitHub org that owns the website repo.",
				// EW: admin-aware dropdown. The widget fetches the caller's allowed
				// cluster sources from `GET /api/deploy/cluster-sources` (filtered by
				// `isPlatformAdmin` server-side, since the client is never told the
				// admin flag) and renders human labels. Falls back to the raw `enum`
				// in renderers that don't know the widget.
				'x-widget': 'k8s-cluster-source'
			},
			kubeconfig: {
				type: 'string',
				title: 'kubeconfig',
				description:
					"Paste the contents of your ~/.kube/config or a service-account-scoped equivalent. Only used when 'Target cluster' is 'custom-kubeconfig' — ignored otherwise.",
				'x-secret': true,
				'x-scope': 'user',
				'x-widget': 'textarea',
				// EW-616: hide the kubeconfig field when the user picked a
				// platform-managed cluster; the deploy service substitutes
				// the platform's kubeconfig from env at deploy time.
				'x-showIf': { field: 'clusterSource', value: 'custom-kubeconfig' }
			},
			kubeContext: {
				type: 'string',
				title: 'Context (optional)',
				description: "Defaults to the kubeconfig's current-context.",
				// EW-616: only meaningful with a user-pasted kubeconfig.
				'x-showIf': { field: 'clusterSource', value: 'custom-kubeconfig' }
			},
			namespace: {
				type: 'string',
				title: 'Namespace',
				// `DEFAULT_NAMESPACE` (`ever-works`) is kept for back-compat with
				// pre-existing custom-kubeconfig Works that rely on it on their OWN
				// cluster. It is intentionally NOT surfaced/used for shared or
				// managed sources: the server (`DeployService.resolveDeployNamespace`)
				// OVERRIDES it with a deterministic per-tenant namespace on shared
				// clusters and REJECTS reserved namespaces on every source, so this
				// default can never reach a platform-owned namespace.
				default: DEFAULT_NAMESPACE,
				description:
					"Only used when 'Target cluster' is 'custom-kubeconfig' (your own cluster). On platform-managed clusters the namespace is assigned automatically per tenant and this field is ignored.",
				// Defense-in-depth for the server-side namespace enforcement:
				// hide/lock the field for platform-managed sources so a shared- or
				// internal-cluster tenant cannot even attempt to type a foreign or
				// system namespace. The server remains authoritative regardless.
				'x-showIf': { field: 'clusterSource', value: 'custom-kubeconfig' }
			},
			registry: REGISTRY_SCHEMA,
			ingressClass: {
				type: 'string',
				title: 'Ingress class',
				description:
					'Leave blank to use the cluster default. Save the form once to populate the dropdown from your cluster.',
				'x-widget': 'cluster-ingress-class'
			},
			ingressHost: {
				type: 'string',
				title: 'Default ingress host (optional)'
			},
			tlsIssuer: {
				type: 'string',
				title: 'cert-manager issuer (optional)'
			},
			replicas: {
				type: 'integer',
				title: 'Replicas',
				default: DEFAULT_REPLICAS,
				minimum: 1,
				maximum: 10
			},
			// Per-Work sizing. `deploy()` already reads all four off `settings`,
			// but PluginSettingsService resolves settings by iterating the SCHEMA's
			// keys — anything not declared here is silently dropped, so without
			// these entries the overrides existed in name only: you could persist
			// `memoryLimit` on a Work, see it stored, and still get the default
			// rendered into the Deployment. Verified by reading back the ReplicaSet.
			cpuRequest: {
				type: 'string',
				title: 'CPU request',
				description: "Kubernetes quantity, e.g. '100m'. Small requests keep scheduling cheap."
			},
			memoryRequest: {
				type: 'string',
				title: 'Memory request',
				description:
					"Kubernetes quantity, e.g. '512Mi' or '500M'. Platform-managed clusters use 512Mi only as an admission floor; set a larger measured value for each heavier catalogue."
			},
			cpuLimit: {
				type: 'string',
				title: 'CPU limit',
				description: "Kubernetes quantity, e.g. '2'."
			},
			memoryLimit: {
				type: 'string',
				title: 'Memory limit',
				default: DEFAULT_MEMORY_LIMIT,
				description:
					"Kubernetes quantity, e.g. '2Gi'. Must fit the target node: a limit larger than a node's allocatable memory schedules fine (requests are small) and then OOM-kills the pod climbing toward a ceiling that does not exist."
			},
			// APW-07 T19 (plan §4.9:630-633). Declared here because `PluginSettingsService` resolves settings by
			// iterating THIS schema's keys — a setting the schema does not declare is silently dropped before a
			// provider could ever read it (the same trap `cpuRequest`/`memoryLimit` above record).
			appDependencyStorageClass: {
				type: 'string',
				title: 'Dependency storage class',
				description:
					"StorageClass every in-cluster dependency volume is created on. Leave blank to use the cluster's own default class; a cluster with neither fails Postgres with 'no default storage class'."
			},
			appDependencySizes: {
				type: 'object',
				title: 'Dependency sizes',
				description:
					'Default volume size in GiB per dependency kind. A default for the configure dialog, not a floor — the owner may pick any size at or above the provider minimum before first provisioning (FR-37).',
				properties: {
					postgres: {
						type: 'integer',
						title: 'Postgres (GiB)',
						minimum: 1,
						default: APP_DEPENDENCY_SIZE_DEFAULTS.postgres
					},
					objectStorage: {
						type: 'integer',
						title: 'Object storage (GiB)',
						minimum: 1,
						default: APP_DEPENDENCY_SIZE_DEFAULTS.objectStorage
					},
					redis: {
						type: 'integer',
						title: 'Redis (GiB)',
						minimum: 1,
						default: APP_DEPENDENCY_SIZE_DEFAULTS.redis
					}
				}
			},
			appDependencyImages: {
				type: 'object',
				title: 'Dependency images (admin)',
				description:
					'Digest-pinned image overrides per kind and version. Leave a field blank to use the pinned default. A value that is not a sha256 digest is ignored, so a typo can never publish an unpinned image.',
				'x-adminOnly': true,
				properties: {
					postgres: {
						type: 'object',
						title: 'Postgres server',
						properties: {
							'14': { type: 'string', title: 'Postgres 14' },
							'15': { type: 'string', title: 'Postgres 15' },
							'16': { type: 'string', title: 'Postgres 16' },
							'17': { type: 'string', title: 'Postgres 17' }
						}
					},
					postgresClient: {
						type: 'object',
						title: 'Postgres client (extension job)',
						properties: {
							'14': { type: 'string', title: 'Postgres 14 client' },
							'15': { type: 'string', title: 'Postgres 15 client' },
							'16': { type: 'string', title: 'Postgres 16 client' },
							'17': { type: 'string', title: 'Postgres 17 client' }
						}
					},
					redis: { type: 'string', title: 'Redis 7' },
					objectStorage: { type: 'string', title: 'S3-compatible server' },
					objectStorageClient: { type: 'string', title: 'S3 client (init job)' }
				}
			}
		},
		// `kubeconfig` is only required when `clusterSource === 'custom-kubeconfig'`
		// (the default for back-compat). When `clusterSource` is a platform-managed
		// value the platform substitutes the kubeconfig at deploy time and the
		// pasted field is ignored. See EW-616.
		allOf: [
			{
				if: {
					anyOf: [
						{ not: { required: ['clusterSource'] } },
						{ properties: { clusterSource: { const: 'custom-kubeconfig' } } }
					]
				},
				then: { required: ['kubeconfig'] }
			}
		]
	};

	private context?: PluginContext;
	private readonly api: KubernetesApiService;
	private readonly registries: RegistryProviderRegistry;
	private readonly ingressStrategies: IngressStrategyRegistry;
	private readonly dnsResolver: DnsResolver;
	// The App runtime's four collaborators (APW-06 T14). Built over the same `KubernetesApiService`
	// the pre-existing deployment path uses, so an App call and a website deploy reach one client.
	private readonly appDeployer: AppDeployer;
	private readonly appStatusReader: AppStatusReader;
	private readonly appLifecycle: AppLifecycle;
	private readonly appClusterChecker: AppClusterChecker;
	/**
	 * APW-07 T19/T20/T21's three providers (plan §4.9:568-633). Built over the same `KubernetesApiService`
	 * the App runtime members use, so a dependency call and a deploy reach one client.
	 */
	private readonly postgresDependencies: PostgresDependencyProvider;
	/** T20's provider (`k8s-inline-redis`). */
	private readonly redisDependencies: RedisDependencyProvider;
	/** T21's provider (`k8s-inline-minio`). */
	private readonly objectStorageDependencies: ObjectStorageDependencyProvider;
	/**
	 * The providers by id — the one lookup {@link dependencyProviderFor} performs, so adding a provider is one
	 * entry in the published descriptor list and one entry here, and the two cannot drift silently: a
	 * descriptor without an instance answers `null` (`providerNotSupported`), never another provider's
	 * implementation.
	 */
	private readonly dependencyProviderInstances: Readonly<Partial<Record<string, AppDependencyK8sProvider>>>;
	/** §6.1 step 2's DNS seam. Unset in production (the guard falls back to `node:dns`). */
	private readonly clusterAddressResolver?: KubeconfigDnsResolver;

	constructor(
		opts: {
			api?: KubernetesApiService;
			registries?: RegistryProviderRegistry;
			ingressStrategies?: IngressStrategyRegistry;
			dnsResolver?: DnsResolver;
			/** Test seam for §6.1: the resolver `pinKubeconfigServer` resolves the cluster host with. */
			clusterAddressResolver?: KubeconfigDnsResolver;
		} = {}
	) {
		this.api = opts.api ?? new KubernetesApiService();
		this.registries = opts.registries ?? defaultRegistryProviderRegistry;
		this.ingressStrategies = opts.ingressStrategies ?? defaultIngressStrategyRegistry;
		this.dnsResolver = opts.dnsResolver ?? defaultDnsResolver;
		this.appDeployer = new AppDeployer(this.api);
		this.appStatusReader = new AppStatusReader(this.api);
		this.appLifecycle = new AppLifecycle(this.api);
		this.appClusterChecker = new AppClusterChecker(this.api);
		this.postgresDependencies = new PostgresDependencyProvider(this.api);
		this.redisDependencies = new RedisDependencyProvider(this.api);
		this.objectStorageDependencies = new ObjectStorageDependencyProvider(this.api);
		this.dependencyProviderInstances = {
			[POSTGRES_PROVIDER_ID]: this.postgresDependencies,
			[REDIS_PROVIDER_ID]: this.redisDependencies,
			[OBJECT_STORAGE_PROVIDER_ID]: this.objectStorageDependencies
		};
		this.clusterAddressResolver = opts.clusterAddressResolver;
	}

	// IPlugin lifecycle ------------------------------------------------------

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Kubernetes plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Kubernetes plugin is ready (cluster reachability is per-token)',
			checkedAt: Date.now()
		};
	}

	validateSettings(settings: Record<string, unknown>): ValidationResult {
		const errors: ValidationError[] = [];
		const clusterSource = isClusterSource(settings.clusterSource) ? settings.clusterSource : undefined;
		// Kubernetes accepts DecimalSI, BinarySI, and exponent quantities. Do
		// not narrow syntax for a customer's own cluster; its API server remains
		// authoritative. Managed clusters need local parsing only because the
		// platform enforces an admission floor before it writes any resource.
		if (!isPlatformManagedClusterSource(clusterSource)) return { valid: true };

		const memoryRequest = settings.memoryRequest ?? DEFAULT_MEMORY_REQUEST;
		const memoryLimit = settings.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
		const requestQuantity = parseKubernetesQuantity(memoryRequest);
		const limitQuantity = parseKubernetesQuantity(memoryLimit);

		if (requestQuantity === undefined) {
			errors.push({
				path: 'memoryRequest',
				code: 'INVALID_MEMORY_QUANTITY',
				message: "Memory request must be a valid Kubernetes quantity such as '512Mi', '500M', or '1e9'."
			});
		}

		if (limitQuantity === undefined) {
			errors.push({
				path: 'memoryLimit',
				code: 'INVALID_MEMORY_QUANTITY',
				message: "Memory limit must be a valid Kubernetes quantity such as '2Gi' or '2G'."
			});
		}

		if (
			requestQuantity !== undefined &&
			limitQuantity !== undefined &&
			compareQuantities(requestQuantity, limitQuantity) > 0
		) {
			errors.push({
				path: 'memoryRequest',
				code: 'MEMORY_REQUEST_EXCEEDS_LIMIT',
				message: 'Memory request must not exceed the memory limit.'
			});
		}

		if (requestQuantity !== undefined && compareQuantities(requestQuantity, MANAGED_MEMORY_REQUEST_MINIMUM) < 0) {
			errors.push({
				path: 'memoryRequest',
				code: 'MANAGED_MEMORY_REQUEST_TOO_LOW',
				message:
					'Platform-managed clusters require a 512Mi admission floor; heavier sites need a larger measured request.'
			});
		}

		if (limitQuantity !== undefined && compareQuantities(limitQuantity, MANAGED_MEMORY_REQUEST_MINIMUM) < 0) {
			errors.push({
				path: 'memoryLimit',
				code: 'MANAGED_MEMORY_LIMIT_TOO_LOW',
				message: 'Platform-managed memory limit must cover the 512Mi admission floor.'
			});
		}

		return errors.length > 0 ? { valid: false, errors } : { valid: true };
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Deploy your works to a Kubernetes cluster you control',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'AGPL-3.0',
			builtIn: true,
			systemPlugin: true,
			autoEnable: true,
			visibility: 'user-only',
			readme: [
				'## What does the Kubernetes plugin do?',
				'',
				'It deploys your work as a containerised website to any Kubernetes cluster you control.',
				'',
				'## Why use it?',
				'',
				'- **Bring your own cluster** — EKS / GKE / AKS / k3s / on-prem',
				'- **GitHub Container Registry by default** — no extra configuration if GitHub is connected',
				'- **Pluggable ingress** — built-in strategies for ingress-nginx and Traefik, generic fallback for everything else',
				"- **Custom domains** — patches your work's Ingress with cert-manager-friendly annotations",
				'',
				'## Getting started',
				'',
				'1. Generate a kubeconfig (a service-account-scoped one is recommended).',
				'2. Paste it in the **kubeconfig** field below and click **Save & verify**.',
				'3. The platform reports back the cluster name, server version, and detected ingress controllers.',
				'4. Choose Kubernetes as the deployment provider on a work and deploy.'
			].join('\n'),
			homepage: 'https://kubernetes.io/docs/tasks/access-application-cluster/configure-access-multiple-clusters/',
			uiHints: {
				includeInOnboarding: true,
				onboardingPriority: 4,
				onboardingDescription: 'Deploy your works to your own Kubernetes cluster by pasting your kubeconfig',
				completionFields: ['kubeconfig'],
				verifiesOnSave: true
			},
			icon: {
				type: 'lucide',
				value: 'Container',
				backgroundColor: '#326CE5'
			}
		};
	}

	// IDeploymentPlugin -----------------------------------------------------

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const cfg = this.coerceSettings(settings);
		const clusterSource: ClusterSource = cfg.clusterSource ?? 'custom-kubeconfig';

		// Platform-managed cluster sources don't use the pasted kubeconfig —
		// the platform substitutes the right one at deploy time. There is
		// nothing to verify here from the user's session.
		if (clusterSource !== 'custom-kubeconfig') {
			return {
				success: true,
				message: `Will deploy to platform-managed cluster '${clusterSource}'.`,
				details: { clusterSource }
			};
		}

		if (!cfg.kubeconfig || !cfg.kubeconfig.trim()) {
			return { success: false, message: 'Paste a kubeconfig before validating.' };
		}

		try {
			const info = await this.api.validateConnection(cfg.kubeconfig, {
				contextOverride: cfg.kubeContext,
				hasStrategyFor: (controller) => Boolean(controller && this.ingressStrategies.hasStrategyFor(controller))
			});

			// Note: when registry.kind === 'github' we do NOT reach into the
			// GitHub plugin from here — there's no registered cross-plugin
			// capability surface for it yet. GHCR-specific validation (e.g.
			// "is GitHub connected?") happens at deploy time, where the
			// deploy service resolves GitHub credentials from plugin-settings
			// and passes them via DeploymentConfig.options.

			return {
				success: true,
				message: this.formatSuccessMessage(info.clusterName, info.serverVersion),
				details: {
					clusterName: info.clusterName,
					serverUrl: info.serverUrl,
					serverVersion: info.serverVersion,
					serverFingerprint: info.serverFingerprint,
					ingressClasses: info.ingressClasses,
					requiresExecPlugin: info.requiresExecPlugin
				}
			};
		} catch (err) {
			const scrubPatterns = this.runtimeScrubPatterns(cfg);
			const scrubbed = scrubError(err, scrubPatterns);
			return { success: false, message: scrubbed.message };
		}
	}

	async validateToken(token: string): Promise<boolean> {
		if (!token) return false;
		try {
			parseKubeconfig(token);
			return true;
		} catch {
			return false;
		}
	}

	async getTeams(_token: string): Promise<Array<{ id: string; slug: string; name: string | null }>> {
		// Kubernetes has no built-in teams concept. Returning [] is the
		// honest answer; the deploy facade falls back to "no team scope".
		return [];
	}

	/**
	 * Fleet (Wave 12) — read-only node inventory of the cluster the
	 * given kubeconfig points at. The platform side calls this ONLY for
	 * user-configured clusters (`clusterSource: 'custom-kubeconfig'`);
	 * platform-managed sources never reach here from Fleet.
	 */
	async listClusterNodes(kubeconfig: string, contextOverride?: string): Promise<ClusterNodeDescriptor[]> {
		if (!kubeconfig) return [];
		return this.api.listNodes(kubeconfig, contextOverride);
	}

	async deploy(config: DeploymentConfig, kubeconfig: string): Promise<DeploymentResult> {
		const opts = (config.options ?? {}) as DeployOptions;
		const settings = {
			...(await this.loadSettings()),
			...((opts.settingsOverride ?? {}) as Partial<KubernetesSettings>)
		} as KubernetesSettings;
		applyKubeContextOverride(settings, opts.kubeContextOverride);
		// `namespaceOverride` is the namespace the PLATFORM enforced server-side
		// (per-tenant override + reserved-namespace blocklist). It must win over
		// the plugin's own persisted `namespace`, which is free-text the user
		// typed and carries no such guarantee.
		const namespace = opts.namespaceOverride?.trim() || settings.namespace?.trim() || DEFAULT_NAMESPACE;
		const replicas = clampReplicas(settings.replicas);
		const registry = settings.registry ?? { kind: 'github' as const };
		// Security: the caller-supplied gitSha is interpolated into the Docker
		// image tag below. Strip any character outside the Docker tag charset so
		// a crafted value (e.g. `latest@sha256:...`) cannot pin an unintended
		// image or produce an invalid reference. Legitimate hex SHAs are
		// unaffected. Fall back to a timestamp tag if nothing valid remains.
		const gitSha = sanitiseDockerTag((opts.gitSha ?? '').slice(0, 12)) || Date.now().toString(36).slice(0, 12);
		const slug = sanitiseSlug(config.projectName);
		// CI pushes images named after the WEBSITE REPO, which is not always
		// the work slug (legacy works: slug `mcpserver`, repo
		// `awesome-mcp-servers-website`). `imageName` lets the caller pin the
		// repo name for the image ref while manifests keep the slug.
		const imageName = sanitiseSlug(opts.imageName ?? config.projectName);
		const createdAt = new Date().toISOString();

		const provider = this.registries.resolve(registry.kind);
		const registryCtx: RegistryDeployContext = {
			workSlug: slug,
			githubOwner: opts.githubOwner,
			websiteRepoIsPrivate: opts.websiteRepoIsPrivate
		};
		const visibility: ResolvedImageVisibility = provider.resolveVisibility(registry, registryCtx);
		const imageBase = provider.imageBase(registry, registryCtx);
		const image = `${imageBase}/${imageName}:${gitSha}`;

		const ingressClass = settings.ingressClass;
		const controller = await this.controllerForClassName(kubeconfig, settings.kubeContext, ingressClass);
		const strategy = this.ingressStrategies.selectStrategy(controller);
		const hosts = this.collectHosts(settings, opts);

		// Pull-secret credentials when needed.
		const pullCreds = provider.pullSecretCredentials(registry, registryCtx, visibility);
		let pullSecretName: string | undefined;

		try {
			// Resolve request and limit as a pair before the first write. A legacy
			// managed Work may combine a sub-floor request with an even lower
			// limit; raising only the request would make an invalid Deployment.
			const memorySizing = effectiveMemorySizing(settings);

			// Idempotently ensure the namespace exists. Without this, the
			// SSA patches below 404 against a fresh cluster (e.g. the
			// default `ever-works` namespace on a brand-new EKS cluster).
			await this.api.ensureNamespace(kubeconfig, namespace, settings.kubeContext);

			if (pullCreds) {
				const password = registry.kind === 'github' ? (opts.githubReadPackagesToken ?? '') : pullCreds.password;
				if (registry.kind === 'github' && !password) {
					throw new K8sPluginError(
						'GITHUB_NOT_CONNECTED',
						'A read:packages token from the GitHub plugin is required to pull a private GHCR image.'
					);
				}
				pullSecretName = pullSecretNameFor(slug);
				const secret = buildImagePullSecret({
					name: pullSecretName,
					namespace,
					server: pullCreds.server,
					username: pullCreds.username,
					password,
					workId: config.projectName,
					workSlug: slug
				});
				await this.api.applyImagePullSecret(kubeconfig, secret, settings.kubeContext);
			}

			// Server-side runtime env: apply the Secret BEFORE the Deployment so
			// the first pod generation already sees it (envFrom is resolved at
			// pod creation). Applied every deploy — SSA makes it idempotent and
			// picks up rotated values.
			let runtimeEnvSecretName: string | undefined;
			if (opts.runtimeEnv && Object.keys(opts.runtimeEnv).length > 0) {
				runtimeEnvSecretName = `${slug}-runtime-env`;
				const runtimeEnvSecret = buildRuntimeEnvSecret({
					name: runtimeEnvSecretName,
					namespace,
					workId: config.projectName,
					workSlug: slug,
					env: opts.runtimeEnv
				});
				await this.api.applySecret(kubeconfig, runtimeEnvSecret, settings.kubeContext);
			}

			const renderInputs = {
				workId: config.projectName,
				workSlug: slug,
				namespace,
				image,
				replicas,
				containerPort: CONTAINER_PORT,
				pullSecretName,
				envFromSecretName: runtimeEnvSecretName,
				imagePullPolicy: opts.imagePullPolicy,
				// Per-Work sizing, resolved through the same settings merge as the
				// rest (settingsOverride layers the work tier over the plugin's own).
				cpuRequest: settings.cpuRequest,
				// Stored legacy managed settings may still say 256Mi. Normalize the
				// request only after validating it against the effective limit, and
				// never mutate the Work row as a side effect of deployment.
				memoryRequest: memorySizing.memoryRequest,
				cpuLimit: settings.cpuLimit,
				memoryLimit: memorySizing.memoryLimit,
				// Makes the pod template differ between deploys of the same branch.
				// The image tag is a mutable alias, so without this the manifest is
				// identical every time and server-side apply rolls nothing.
				podAnnotations: {
					// NOT gitSha: that is the branch alias and is identical on every
					// deploy, which would leave the pod template unchanged and defeat
					// the point. Fall back to a per-deploy timestamp.
					'ever-works.io/revision': opts.revision?.trim() || `t${Date.now().toString(36)}`,
					...(opts.runtimeEnv && Object.keys(opts.runtimeEnv).length
						? { 'ever-works.io/runtime-env-hash': hashRuntimeEnv(opts.runtimeEnv) }
						: {})
				},
				hosts,
				ingressClass,
				tlsIssuer: settings.tlsIssuer,
				ingressController: controller
			};
			const deploymentManifest = buildDeployment(renderInputs);
			const serviceManifest = buildService(renderInputs);
			const ingressManifest = buildIngress(renderInputs, strategy);

			await this.api.applyDeployment(kubeconfig, deploymentManifest, settings.kubeContext);
			await this.api.applyService(kubeconfig, serviceManifest, settings.kubeContext);
			if (ingressManifest) {
				await this.api.applyIngress(kubeconfig, ingressManifest, settings.kubeContext);
			}

			return {
				id: makeDeploymentId(namespace, slug),
				status: 'deploying',
				url: hosts.length > 0 ? `https://${hosts[0]}` : undefined,
				createdAt
			};
		} catch (err) {
			const scrubPatterns = this.runtimeScrubPatterns({ kubeconfig, registry });
			const scrubbed = scrubError(err, scrubPatterns);
			return {
				id: makeDeploymentId(namespace, slug),
				status: 'error',
				error: scrubbed.message,
				createdAt,
				completedAt: new Date().toISOString()
			};
		}
	}

	async getDeploymentStatus(
		deploymentId: string,
		kubeconfig: string,
		context?: DeploymentLookupContext
	): Promise<DeploymentResult> {
		const settings = await this.loadEffectiveDeploymentSettings(context);
		const { namespace, name } = resolveDeploymentTarget(deploymentId, context);
		const effectiveDeploymentId = makeDeploymentId(namespace, name);
		const createdAt = new Date().toISOString();

		try {
			const deployment = await this.api.getDeployment(kubeconfig, namespace, name, settings.kubeContext);
			if (!deployment) {
				return { id: effectiveDeploymentId, status: 'pending', createdAt };
			}
			const status = mapDeploymentToStatus(deployment);
			return {
				id: effectiveDeploymentId,
				status,
				createdAt,
				completedAt: status === 'ready' || status === 'error' ? new Date().toISOString() : undefined
			};
		} catch (err) {
			const scrubbed = scrubError(err, this.runtimeScrubPatterns({ kubeconfig }));
			return {
				id: effectiveDeploymentId,
				status: 'error',
				error: scrubbed.message,
				createdAt,
				completedAt: new Date().toISOString()
			};
		}
	}

	async listProjects(kubeconfig: string): Promise<DeploymentProject[]> {
		const settings = await this.loadSettings();
		try {
			const deployments = await this.api.listManagedDeployments(kubeconfig, settings.kubeContext);
			return deployments.map((d) => ({
				id: makeDeploymentId(d.namespace, d.name),
				name: d.name,
				createdAt: new Date().toISOString()
			}));
		} catch {
			return [];
		}
	}

	async lookupExistingDeployment(
		projectName: string,
		kubeconfig: string,
		_teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<{ found: boolean; website?: string; deploymentState?: string; projectId?: string }> {
		const settings = await this.loadEffectiveDeploymentSettings(context);
		const projectNameOverride = context?.projectNameOverride?.trim();
		const slug = sanitiseSlug(projectNameOverride || projectName);
		const requestedNamespace = context?.namespaceOverride?.trim();
		const namespace =
			(requestedNamespace && isValidK8sNamespace(requestedNamespace) ? requestedNamespace : undefined) ??
			settings.namespace?.trim() ??
			DEFAULT_NAMESPACE;
		const deployment = await this.api.getDeployment(kubeconfig, namespace, slug, settings.kubeContext);
		if (!deployment) return { found: false };
		const projectId = makeDeploymentId(namespace, slug);
		return {
			found: true,
			projectId,
			website: await this.resolveWebsiteUrl(kubeconfig, namespace, slug, settings),
			deploymentState: toVerifierDeploymentState(mapDeploymentToStatus(deployment))
		};
	}

	async getDomains(
		projectId: string,
		kubeconfig: string,
		_teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<DeploymentDomain[]> {
		const settings = await this.loadEffectiveDeploymentSettings(context);
		const { namespace, name } = resolveDeploymentTarget(projectId, context);
		const ingress = await this.api.readIngress(kubeconfig, namespace, name, settings.kubeContext);
		if (!ingress?.spec) return [];
		const spec = ingress.spec as { rules?: Array<{ host?: string }> };
		const lbHost =
			ingress.status?.loadBalancer?.ingress?.[0]?.hostname?.toLowerCase() ||
			ingress.status?.loadBalancer?.ingress?.[0]?.ip ||
			undefined;
		// Listing domains does not perform live DNS — that's `verifyDomain`'s
		// job. Returning `verified: false` here matches `addDomain` and lets
		// the UI show "pending verification" for hosts the user hasn't
		// explicitly verified yet. (Previously this returned
		// `verified: true` blindly, masking misconfigured DNS.)
		return (spec.rules ?? [])
			.map((r) => r.host)
			.filter((h): h is string => Boolean(h))
			.map((host) => ({
				name: host,
				verified: false,
				verification: buildDnsGuidance(host, lbHost)
			}));
	}

	async addDomain(
		projectId: string,
		domain: string,
		kubeconfig: string,
		_teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<AddDomainResult> {
		const settings = await this.loadEffectiveDeploymentSettings(context);
		// Security: the domain is written verbatim as the Ingress `host:` rule.
		// Reject anything that is not a strict RFC-1123 hostname so a value like
		// `*` (catch-all rule that hijacks unmatched cluster traffic) or an empty
		// / illegal-character host cannot be injected into the Ingress.
		const host = normaliseIngressHost(domain);
		if (!host) {
			throw new K8sPluginError('UNKNOWN', 'Invalid domain: provide a valid hostname.');
		}
		const { namespace, name } = resolveDeploymentTarget(projectId, context);
		const controller = await this.controllerForClassName(kubeconfig, settings.kubeContext, settings.ingressClass);
		const strategy = this.ingressStrategies.selectStrategy(controller);

		const existing = (await this.api.readIngress(kubeconfig, namespace, name, settings.kubeContext)) ?? {
			spec: { ingressClassName: settings.ingressClass, rules: [], tls: [] }
		};

		const patched = appendHostToIngress(
			existing as { spec?: { rules?: unknown[]; tls?: unknown[]; ingressClassName?: string } },
			{
				// Security: write the validated/normalised host, never the raw input.
				host,
				serviceName: name,
				strategy,
				tlsIssuer: settings.tlsIssuer
			}
		);

		const body = {
			apiVersion: 'networking.k8s.io/v1',
			kind: 'Ingress',
			metadata: { name, namespace },
			spec: patched.spec
		};
		await this.api.applyIngress(kubeconfig, body, settings.kubeContext);

		return {
			domain: { name: domain, verified: false, verification: buildDnsGuidance(domain) },
			verified: false
		};
	}

	async removeDomain(
		projectId: string,
		domain: string,
		kubeconfig: string,
		_teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<boolean> {
		const settings = await this.loadEffectiveDeploymentSettings(context);
		const { namespace, name } = resolveDeploymentTarget(projectId, context);
		const controller = await this.controllerForClassName(kubeconfig, settings.kubeContext, settings.ingressClass);
		const strategy = this.ingressStrategies.selectStrategy(controller);
		const existing = await this.api.readIngress(kubeconfig, namespace, name, settings.kubeContext);
		if (!existing) return false;

		const patched = removeHostFromIngress(
			existing as { spec?: { rules?: unknown[]; tls?: unknown[]; ingressClassName?: string } },
			{ host: domain, strategy, tlsIssuer: settings.tlsIssuer }
		);
		const body = {
			apiVersion: 'networking.k8s.io/v1',
			kind: 'Ingress',
			metadata: { name, namespace },
			spec: patched.spec
		};
		await this.api.applyIngress(kubeconfig, body, settings.kubeContext);
		return true;
	}

	async verifyDomain(
		projectId: string,
		domain: string,
		kubeconfig: string,
		_teamScope?: string,
		context?: DeploymentLookupContext
	): Promise<DeploymentDomain> {
		const settings = await this.loadEffectiveDeploymentSettings(context);
		const { namespace, name } = resolveDeploymentTarget(projectId, context);
		// Resolve the cluster's actual ingress LB host/IP. Without this, any
		// domain with any DNS record was returned `verified: true` —
		// including domains pointing at a completely unrelated server.
		// Passing the LB target makes the resolver assert "domain points
		// HERE", not just "domain points somewhere".
		let expectedTarget: string | undefined;
		try {
			expectedTarget =
				(await this.api.getIngressLoadBalancerHost(kubeconfig, namespace, name, settings.kubeContext)) ??
				undefined;
		} catch {
			// Cluster unreachable mid-verify — fall through with no target.
			// Returning `verified: false` + DNS guidance is the right
			// behaviour: we can't confirm, so don't claim success.
			expectedTarget = undefined;
		}
		const result = await verifyDomainResolution(domain, expectedTarget, this.dnsResolver);
		// If we couldn't resolve a target at all (LB pending, ingress not
		// applied yet), force `verified: false` — `verifyDomainResolution`
		// would otherwise return true on "any record exists".
		if (!expectedTarget) {
			return {
				name: result.name,
				verified: false,
				verification: result.verification ?? buildDnsGuidance(domain)
			};
		}
		return result;
	}

	// Optional contract methods for the deploy service ----------------------

	getWorkflowFilenames(): string[] {
		return ['deploy_k8s.yaml'];
	}

	async getDeploymentSecrets(settings: Record<string, unknown>): Promise<Record<string, string>> {
		const cfg = this.coerceSettings(settings);
		const out: Record<string, string> = {
			K8S_NAMESPACE: cfg.namespace?.trim() || DEFAULT_NAMESPACE,
			K8S_CLUSTER_SOURCE: cfg.clusterSource ?? 'custom-kubeconfig'
		};
		if (cfg.kubeContext) out.K8S_KUBE_CONTEXT = cfg.kubeContext;
		if (cfg.ingressClass) out.K8S_INGRESS_CLASS = cfg.ingressClass;
		if (cfg.ingressHost) out.K8S_INGRESS_HOST = cfg.ingressHost;
		// EW-741 — additional Ingress hosts (custom domains). Deduped against
		// `ingressHost`; comma-separated for the workflow renderer. Skipped
		// when the list is empty so the secret is only written for Works that
		// actually have custom domains attached.
		if (Array.isArray(cfg.extraHosts) && cfg.extraHosts.length > 0) {
			const primary = cfg.ingressHost?.trim().toLowerCase();
			const seen = new Set<string>();
			const extras: string[] = [];
			for (const host of cfg.extraHosts) {
				if (typeof host !== 'string') continue;
				const normalized = host.trim().toLowerCase();
				if (!normalized) continue;
				if (primary && normalized === primary) continue;
				if (seen.has(normalized)) continue;
				seen.add(normalized);
				extras.push(normalized);
			}
			if (extras.length > 0) out.K8S_EXTRA_HOSTS = extras.join(',');
		}
		if (cfg.tlsIssuer) out.K8S_TLS_ISSUER = cfg.tlsIssuer;
		if (cfg.replicas) out.K8S_REPLICAS = String(clampReplicas(cfg.replicas));

		const registry: RegistryConfig = cfg.registry ?? { kind: 'github' };
		out.K8S_REGISTRY_KIND = registry.kind;

		if (registry.kind === 'github') {
			if (registry.owner) out.K8S_REGISTRY_OWNER = registry.owner;
			if (registry.visibility) out.K8S_REGISTRY_VISIBILITY = registry.visibility;
		} else if (registry.kind === 'dockerhub') {
			out.REGISTRY_USERNAME = registry.username;
			out.REGISTRY_PASSWORD = registry.password;
		} else if (registry.kind === 'generic') {
			out.REGISTRY_SERVER = registry.server;
			out.REGISTRY_USERNAME = registry.username;
			out.REGISTRY_PASSWORD = registry.password;
		}
		return out;
	}

	// App members (APW-06 T14) ----------------------------------------------

	/**
	 * Deploy an App Work to `your-cluster` (plan §5.5). The phase machine, the rollback and the
	 * object rendering all live in `AppDeployer`; this method's own job is the §6.1 guard plus the
	 * `ever-works-apps` refusal R-5 requires, and it is the first thing that runs.
	 */
	async deployApp(input: AppRenderInput, credential: string, hooks: AppDeployHooks): Promise<AppDeployResult> {
		this.assertThisPluginServes(input?.ref);
		const pinned = await this.guardedAppCredential(credential, input?.ref?.kubeContext);
		return this.appDeployer.deployApp(input, pinned, hooks);
	}

	/** Observe the App Work's live state (FR-46) — `AppStatusReader.getAppStatus`. */
	async getAppStatus(ref: AppTargetRef, credential: string, spec: AppStatusSpec): Promise<AppStatusSnapshot> {
		this.assertThisPluginServes(ref);
		const pinned = await this.guardedAppCredential(credential, ref?.kubeContext);
		return this.appStatusReader.getAppStatus(ref, pinned, spec);
	}

	/** Run one App spec job once (FR-51) — `AppLifecycle.runAppJob`. */
	async runAppJob(ref: AppTargetRef, credential: string, job: AppJobRunRequest): Promise<AppJobResult> {
		this.assertThisPluginServes(ref);
		const pinned = await this.guardedAppCredential(credential, ref?.kubeContext);
		return this.appLifecycle.runAppJob(ref, pinned, job);
	}

	/** Remove the App Work's workloads while keeping its data (FR-50) — `AppLifecycle.destroyApp`. */
	async destroyApp(
		ref: AppTargetRef,
		credential: string,
		opts: { deleteVolumes: boolean }
	): Promise<AppDestroyResult> {
		this.assertThisPluginServes(ref);
		const pinned = await this.guardedAppCredential(credential, ref?.kubeContext);
		return this.appLifecycle.destroyApp(ref, pinned, opts);
	}

	/**
	 * The expiry a **verification** namespace declares, or `null` — the read APW-06
	 * T20's facade reported missing from the contract.
	 *
	 * §4.12:646-647 has the namespace carry `ever-works.io/expires-at`
	 * (`now + ttlMinutes`), and §4.12:659-660 says that annotation is what lets
	 * APW-04's `app-provision-sweep` clean up a namespace a crashed run left behind.
	 * So this answers the annotation verbatim, and `null` when there is none — never a
	 * computed TTL: the caller compares the instant, and inventing one here would make
	 * a namespace look alive or expired for a reason nobody can see.
	 *
	 * The same discipline as every other App member: the target must be one this plugin
	 * serves, and the credential is asserted AND pinned before the call. A namespace
	 * that cannot be read answers `null` rather than throwing — a status report is not
	 * the place to fail a sweep, and `null` is already the documented "no expiry known"
	 * answer (T20's seam logs a warning and reports an empty value).
	 */
	async readNamespaceExpiry(ref: AppTargetRef, credential: string): Promise<string | null> {
		this.assertThisPluginServes(ref);
		const pinned = await this.guardedAppCredential(credential, ref?.kubeContext);
		const namespace = String(ref?.namespace ?? '');
		if (!namespace) return null;

		try {
			// The same read the status reader uses for a namespace (`readObject` is the
			// `KubernetesApiService` member that takes a credential and a context; the
			// `readNamespace` helper is not on this class). `''` is the cluster-scoped
			// namespace argument a Namespace read needs — `app-status.reader.ts:648-655`
			// is the precedent, and it is deliberately not re-derived here.
			const live = await this.api.readObject<{
				metadata?: { annotations?: Record<string, string> };
			}>(pinned, 'v1', 'Namespace', '', namespace, ref?.kubeContext ?? undefined);
			const value = live?.metadata?.annotations?.[APP_ANNOTATION_EXPIRES_AT];
			return typeof value === 'string' && value.trim() ? value.trim() : null;
		} catch (error) {
			this.context?.logger?.warn?.(
				`App runtime: reading the expiry of namespace '${namespace}' failed (${scrubError(error).message}).`
			);
			return null;
		}
	}

	/** Pause or resume the App Work's components (FR-49) — `AppLifecycle.scaleApp`. */
	async scaleApp(
		ref: AppTargetRef,
		credential: string,
		mode: 'pause' | 'resume',
		replicas: Record<string, number>,
		resumeChecks?: { smoke: AppSmokeInput[]; deadlines: Record<string, number> }
	): Promise<AppScaleResult> {
		this.assertThisPluginServes(ref);
		const pinned = await this.guardedAppCredential(credential, ref?.kubeContext);
		return this.appLifecycle.scaleApp(ref, pinned, mode, replicas, resumeChecks);
	}

	/** Tail component or job logs, redacted by value (FR-48) — `AppLifecycle.getAppLogs`. */
	async getAppLogs(ref: AppTargetRef, credential: string, req: AppLogRequest): Promise<AppLogTail> {
		this.assertThisPluginServes(ref);
		const pinned = await this.guardedAppCredential(credential, ref?.kubeContext);
		return this.appLifecycle.getAppLogs(ref, pinned, req);
	}

	/**
	 * Verify what the credential may do and report what the cluster has (plan §6.3) —
	 * `AppClusterChecker.checkAppCluster`. The report is T13's `AppClusterCheckReport`, a superset of
	 * the frozen `AppClusterCheck` that also carries the ingress controller's address (GAP-09).
	 */
	async checkAppCluster(credential: string, req: AppClusterCheckRequest): Promise<AppClusterCheckReport> {
		const pinned = await this.guardedAppCredential(credential);
		return this.appClusterChecker.checkAppCluster(pinned, req);
	}

	/** Namespace preparation for dependency provisioning (GAP-06) — `AppLifecycle.prepareAppNamespace`. */
	async prepareAppNamespace(
		ref: AppTargetRef,
		credential: string,
		opts: { isolation: boolean; limitRange: AppLimitRangeInput }
	): Promise<{ warnings: Array<{ code: string; message: string }> }> {
		this.assertThisPluginServes(ref);
		const pinned = await this.guardedAppCredential(credential, ref?.kubeContext);
		return this.appLifecycle.prepareAppNamespace(ref, pinned, opts);
	}

	/**
	 * Re-apply only the `Ingress` for the given hosts — `AppLifecycle.publishAppHosts`. The
	 * `ingress-reconcile` op calls this and never `deployApp` (APW06-G03).
	 */
	async publishAppHosts(
		ref: AppTargetRef,
		credential: string,
		hosts: {
			primary: string | null;
			extra: string[];
			previous: string[];
			tls: string;
			issuer: string | null;
		}
	): Promise<{ ingressAddress: { ip?: string; hostname?: string } | null }> {
		this.assertThisPluginServes(ref);
		const pinned = await this.guardedAppCredential(credential, ref?.kubeContext);
		return this.appLifecycle.publishAppHosts(ref, pinned, hosts);
	}

	// App dependency members (APW-07 T19) -----------------------------------

	/**
	 * May this plugin serve `(kind, target)`? (plan §4.7:516-520, §4.8:543-546.)
	 *
	 * The answer is the descriptor list's: a pair no descriptor offers is `providerNotSupported` without
	 * consulting a provider, and a pair one offers is the provider's own answer. The context is accepted
	 * because the contract passes it — a provider whose *offer* depends on it (`platform-smtp-relay` is
	 * offered only while its admin settings are complete) needs it, and this one does not.
	 *
	 * The target half is what keeps R-5 true for dependencies as well: every descriptor here declares
	 * `your-cluster` only, so `ever-works-apps` is never served from this plugin.
	 */
	async supports(
		kind: AppDependencyKind,
		target: AppDependencyTarget,
		_ctx: AppDependencyContext
	): Promise<AppDependencySupport> {
		const descriptor = (this.dependencyProviders ?? []).find(
			(entry) => entry.kind === kind && (entry.targets ?? []).includes(target)
		);
		const provider = descriptor ? this.dependencyProviderFor(descriptor.id) : null;
		if (!provider) return { supported: false, reason: 'providerNotSupported' };
		return provider.supports(kind, target);
	}

	/**
	 * Provision one dependency (`providerId` selects among this plugin's providers) — plan §4.9.
	 *
	 * The credential is **not** re-guarded here, and that is deliberate: §4.8:547-557 makes APW-06's
	 * `AppRuntimeTargetPort.prepareDependencyTarget(workId)` the one thing that resolves a target, and the job
	 * builds `ctx.cluster` from it before calling a provider. Re-running §6.1's guard over that YAML would
	 * re-resolve an address APW-06 has already pinned, which is exactly the double-resolution the guard exists
	 * to prevent.
	 */
	async provision(providerId: string, ctx: AppDependencyContext): Promise<AppDependencyProvisionOutcome> {
		const provider = this.dependencyProviderFor(providerId);
		if (!provider) {
			return { state: 'failed', reason: 'providerNotSupported', transient: false, detail: { providerId } };
		}
		return provider.provision(providerId, ctx);
	}

	/** Re-read a dependency's outputs — the `refresh` mode (FR-42). */
	async getOutputs(providerId: string, ctx: AppDependencyContext): Promise<Record<string, string>> {
		const provider = this.dependencyProviderFor(providerId);
		if (!provider) {
			throw new K8sPluginError('NOT_CONFIGURED', `No Kubernetes dependency provider serves '${providerId}'.`);
		}
		return provider.getOutputs(providerId, ctx);
	}

	/**
	 * Release, or destroy, one dependency (plan §4.9:624-628).
	 *
	 * A provider this plugin does not serve answers `released` rather than throwing: the caller is releasing a
	 * row it already decided to let go, and failing the release because its provider moved would leave the row
	 * stuck in `deleting` forever.
	 */
	async deprovision(
		providerId: string,
		ctx: AppDependencyContext,
		opts: AppDependencyDeprovisionOptions
	): Promise<AppDependencyDeprovisionOutcome> {
		const provider = this.dependencyProviderFor(providerId);
		if (!provider) return { state: 'released' };
		return provider.deprovision(providerId, ctx, opts);
	}

	/** FR-48/FR-49 — the card's one backup state, read from individual records. */
	async backupStatus(providerId: string, ctx: AppDependencyContext): Promise<AppDependencyBackupStatus> {
		const provider = this.dependencyProviderFor(providerId);
		if (!provider) return { state: 'none' };
		return provider.backupStatus(providerId, ctx);
	}

	/**
	 * The provider behind one id, or `null`.
	 *
	 * One lookup path for all five members, so "which provider answers" is answered once: the descriptor list is
	 * the published contract and {@link dependencyProviderInstances} is what implements it. An id this plugin
	 * does not publish — or publishes without an instance — is `null`, never a fallback to another provider,
	 * because provisioning a dependency with an implementation the owner did not choose is the thing
	 * `AppDependencyFacadeService.select` refuses (plan §4.8:543-544).
	 */
	private dependencyProviderFor(providerId: string): AppDependencyK8sProvider | null {
		const provider = this.dependencyProviderInstances[providerId];
		if (!provider) return null;
		const published = (this.dependencyProviders ?? []).some((entry) => entry.id === providerId);
		return published ? provider : null;
	}

	/**
	 * R-5: this plugin serves App Work targets on `your-cluster` only.
	 *
	 * `ever-works-apps` is APW-10's `apps-tier` plugin — the platform never applies manifests on the
	 * managed tier — and `none` is "no cluster chosen yet". Neither may ever reach a cluster through
	 * here, so the refusal is a property of *this* plugin rather than of the routing that happens to
	 * call it. A ref with no `target` at all is read as `your-cluster`, which is how the App modules
	 * themselves default it (`minimalRenderInput`, `app-lifecycle.ts`).
	 */
	private assertThisPluginServes(ref: AppTargetRef | undefined): void {
		const target = ref?.target;
		if (target === undefined || target === 'your-cluster') return;
		throw new K8sPluginError(
			'NOT_CONFIGURED',
			`The Kubernetes plugin serves App Work targets on 'your-cluster' only; '${target}' is served by the apps-tier plugin (APW-06 R-5).`
		);
	}

	/**
	 * §6.1 over one App credential, whoever supplied it — the reason every App method above calls
	 * this before it touches a collaborator.
	 *
	 * Three steps, in the plan's order: the kubeconfig shapes App Works do not support are refused
	 * (`assertSupportedKubeconfig` — pure, no I/O); every address the server names must be public, or
	 * covered by the operator's own `EVER_WORKS_APPS_CLUSTER_PRIVATE_ALLOWLIST`; and the rewritten
	 * YAML pins `server:` to the validated address with the original name kept as `tls-server-name`,
	 * so nothing can re-resolve between this check and the call.
	 *
	 * The **pinned** YAML is what the `src/app/*` modules receive — it is the credential they hand
	 * to `KubernetesApiService`, and therefore the one the client loads.
	 */
	private async guardedAppCredential(credential: string, kubeContext?: string | null): Promise<string> {
		const allowlist = readClusterPrivateAllowlist();
		if (allowlist.invalid.length > 0) {
			// Plan §6.1: an entry that does not parse never widens the policy — it is reported, then
			// ignored. This is the only reader of the variable in the plugin; it is never shared with
			// the agent's configuration (the k8s plugin does not import agent config at all).
			this.context?.logger.warn(
				`Ignoring ${allowlist.invalid.length} unparseable ${CLUSTER_PRIVATE_ALLOWLIST_ENV} entr${allowlist.invalid.length === 1 ? 'y' : 'ies'}: ${allowlist.invalid.join(', ')}`
			);
		}

		const context = kubeContext ?? undefined;
		assertSupportedKubeconfig(credential, context);
		return pinKubeconfigServer(credential, {
			allowlist: allowlist.cidrs,
			context,
			resolver: this.clusterAddressResolver
		});
	}

	// Helpers ---------------------------------------------------------------

	private async loadSettings(): Promise<KubernetesSettings> {
		if (!this.context) return {};
		const raw = (await this.context.getSettings()) ?? {};
		return this.coerceSettings(raw);
	}

	private async loadEffectiveDeploymentSettings(context?: DeploymentLookupContext): Promise<KubernetesSettings> {
		const settings = {
			...(await this.loadSettings()),
			...this.coerceSettings(context?.settingsOverride ?? {})
		};
		applyKubeContextOverride(settings, context?.kubeContextOverride);
		return settings;
	}

	private coerceSettings(raw: Record<string, unknown>): KubernetesSettings {
		const out: KubernetesSettings = {};
		if (isClusterSource(raw.clusterSource)) out.clusterSource = raw.clusterSource;
		if (typeof raw.kubeconfig === 'string') out.kubeconfig = raw.kubeconfig;
		if (typeof raw.kubeContext === 'string') out.kubeContext = raw.kubeContext;
		// Security: only accept a namespace that is a valid RFC-1123 DNS label.
		// A free-form value could contain path traversal (`../kube-system`) or
		// characters that alter the API request path. Invalid values are dropped
		// so use sites fall back to DEFAULT_NAMESPACE. NOTE: this does NOT stop a
		// tenant from setting a *valid* foreign namespace (e.g. `kube-system`) on
		// a shared cluster — that requires a per-tenant namespace allowlist at the
		// deploy/authorization layer (see deferred IDOR findings).
		if (typeof raw.namespace === 'string' && isValidK8sNamespace(raw.namespace.trim())) {
			out.namespace = raw.namespace;
		}
		if (typeof raw.ingressClass === 'string') out.ingressClass = raw.ingressClass;
		if (typeof raw.ingressHost === 'string') out.ingressHost = raw.ingressHost;
		// EW-741 — additional hosts injected by the deploy orchestrator. Only
		// string entries are accepted; non-string elements are silently dropped
		// so a malformed setting can't surface a TypeError downstream.
		if (Array.isArray(raw.extraHosts)) {
			out.extraHosts = raw.extraHosts.filter((h): h is string => typeof h === 'string');
		}
		if (typeof raw.tlsIssuer === 'string') out.tlsIssuer = raw.tlsIssuer;
		if (typeof raw.replicas === 'number') out.replicas = raw.replicas;

		const reg = raw.registry as Partial<RegistryConfig> | undefined;
		if (reg && typeof reg === 'object' && reg.kind) {
			out.registry = reg as RegistryConfig;
		}
		return out;
	}

	private collectHosts(settings: KubernetesSettings, opts: DeployOptions): string[] {
		const hosts = new Set<string>();
		if (settings.ingressHost?.trim()) hosts.add(settings.ingressHost.trim());
		for (const h of opts.hosts ?? []) {
			if (h?.trim()) hosts.add(h.trim());
		}
		return Array.from(hosts);
	}

	private async resolveWebsiteUrl(
		kubeconfig: string,
		namespace: string,
		name: string,
		settings: KubernetesSettings
	): Promise<string | undefined> {
		const ingress = await this.api.readIngress(kubeconfig, namespace, name, settings.kubeContext);
		const rules = (ingress?.spec as { rules?: Array<{ host?: string }> } | undefined)?.rules ?? [];
		const host = rules.find((rule) => typeof rule.host === 'string' && rule.host.trim().length > 0)?.host;
		return host ? `https://${host}` : undefined;
	}

	private async controllerForClassName(
		kubeconfig: string,
		contextOverride: string | undefined,
		className: string | undefined
	): Promise<string | undefined> {
		if (!className) return undefined;
		try {
			const classes = await this.api.listIngressClasses(
				kubeconfig,
				(c) => Boolean(c && this.ingressStrategies.hasStrategyFor(c)),
				contextOverride
			);
			return classes.find((c) => c.name === className)?.controller;
		} catch {
			return undefined;
		}
	}

	private formatSuccessMessage(clusterName: string, version: string): string {
		return `Connected to cluster '${clusterName}' (${version}).`;
	}

	private runtimeScrubPatterns(input: { kubeconfig?: string; registry?: RegistryConfig }): RegExp[] {
		const patterns: RegExp[] = [];
		const kc = buildSecretPattern(input.kubeconfig);
		if (kc) patterns.push(kc);
		const reg = input.registry;
		if (reg?.kind === 'dockerhub' || reg?.kind === 'generic') {
			const pwd = buildSecretPattern(reg.password);
			if (pwd) patterns.push(pwd);
		}
		return patterns;
	}

	getApi(): KubernetesApiService {
		return this.api;
	}

	getRegistries(): RegistryProviderRegistry {
		return this.registries;
	}

	getIngressStrategies(): IngressStrategyRegistry {
		return this.ingressStrategies;
	}
}

export default KubernetesPlugin;

// Internal helpers -----------------------------------------------------------

function makeDeploymentId(namespace: string, name: string): string {
	return `${namespace}/${name}`;
}

function parseDeploymentId(id: string): { namespace: string; name: string } {
	const slash = id.indexOf('/');
	if (slash <= 0 || slash === id.length - 1) {
		return { namespace: DEFAULT_NAMESPACE, name: id };
	}
	return { namespace: id.slice(0, slash), name: id.slice(slash + 1) };
}

function resolveDeploymentTarget(
	projectId: string,
	context?: DeploymentLookupContext
): { namespace: string; name: string } {
	const parsed = parseDeploymentId(projectId);
	const namespaceOverride = context?.namespaceOverride?.trim();
	if (namespaceOverride && !isValidK8sNamespace(namespaceOverride)) {
		throw new K8sPluginError('NOT_CONFIGURED', 'The effective Kubernetes namespace is invalid.');
	}
	const projectNameOverride = context?.projectNameOverride?.trim();
	const name = projectNameOverride ? sanitiseSlug(projectNameOverride) : parsed.name;
	if (!name) {
		throw new K8sPluginError('NOT_CONFIGURED', 'The effective Kubernetes project name is invalid.');
	}
	return {
		namespace: namespaceOverride || parsed.namespace,
		name
	};
}

function applyKubeContextOverride(settings: KubernetesSettings, override?: string | null): void {
	if (override === null) {
		delete settings.kubeContext;
	} else if (typeof override === 'string') {
		settings.kubeContext = override;
	}
}

function sanitiseSlug(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-+/g, '-')
		.slice(0, 63);
}

// Security: RFC-1123 DNS label (Kubernetes namespace rule). Lowercase
// alphanumerics and hyphens, must start/end alphanumeric, 1–63 chars. Used to
// reject namespace settings that could traverse paths or carry illegal chars.
function isValidK8sNamespace(input: string): boolean {
	return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(input);
}

// Security: reduce a value to the Docker image-tag charset (`[A-Za-z0-9_.-]`)
// and drop any leading separator so the result is a valid tag that cannot pin
// an unintended digest (`@sha256:...`) or break the image reference. Returns an
// empty string if nothing valid remains so the caller can fall back.
function sanitiseDockerTag(input: string): string {
	return input
		.replace(/[^A-Za-z0-9_.-]+/g, '')
		.replace(/^[._-]+/, '')
		.slice(0, 128);
}

// Security: validate + normalise a hostname for use as an Ingress `host:` rule.
// Accepts only a strict RFC-1123 hostname (one or more dot-separated DNS
// labels). Rejects empty strings, bare/leading wildcards (`*`, `*.example.com`)
// and any character outside the label set, preventing catch-all Ingress rules
// that would hijack unmatched cluster traffic. Returns the lowercased host or
// `null` when invalid.
function normaliseIngressHost(input: string): string | null {
	const host = (input ?? '').trim().toLowerCase();
	if (!host || host.length > 253) return null;
	const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
	const labels = host.split('.');
	if (!labels.every((part) => label.test(part))) return null;
	return host;
}

function clampReplicas(input: number | undefined): number {
	if (typeof input !== 'number' || !Number.isFinite(input)) return DEFAULT_REPLICAS;
	return Math.min(10, Math.max(1, Math.floor(input)));
}

function toVerifierDeploymentState(status: DeploymentResult['status']): string {
	switch (status) {
		case 'ready':
			return 'READY';
		case 'error':
			return 'ERROR';
		case 'cancelled':
			return 'CANCELED';
		case 'building':
			return 'BUILDING';
		case 'deploying':
			return 'BUILDING';
		case 'pending':
		default:
			return 'INITIALIZING';
	}
}

export type { IngressClassDescriptor };
