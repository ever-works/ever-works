import type {
	AddDomainResult,
	ConnectionValidationResult,
	DeploymentConfig,
	DeploymentDomain,
	DeploymentProject,
	DeploymentResult,
	IDeploymentPlugin,
	IPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	PluginManifest
} from '@ever-works/plugin';

import { K8sPluginError, buildSecretPattern, scrubError } from './errors.js';
import { KubernetesApiService } from './k8s-api.service.js';
import { defaultIngressStrategyRegistry, IngressStrategyRegistry } from './ingress/strategy.registry.js';
import { defaultRegistryProviderRegistry, RegistryProviderRegistry } from './registries/provider.registry.js';
import { mapDeploymentToStatus } from './status.mapper.js';
import {
	buildDeployment,
	buildImagePullSecret,
	buildIngress,
	buildService,
	pullSecretNameFor
} from './manifest.renderer.js';
import { parseKubeconfig } from './kubeconfig.parser.js';
import {
	appendHostToIngress,
	buildDnsGuidance,
	defaultDnsResolver,
	removeHostFromIngress,
	verifyDomainResolution,
	type DnsResolver
} from './domain.handler.js';
import type {
	IngressClassDescriptor,
	KubernetesSettings,
	RegistryConfig,
	RegistryDeployContext,
	ResolvedImageVisibility
} from './types.js';

const DEFAULT_NAMESPACE = 'ever-works';
const DEFAULT_REPLICAS = 1;
const CONTAINER_PORT = 3000;

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
	readonly capabilities: readonly string[] = ['deployment'];
	readonly providerName = 'kubernetes';

	readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'user-required';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			kubeconfig: {
				type: 'string',
				title: 'kubeconfig',
				description: 'Paste the contents of your ~/.kube/config or a service-account-scoped equivalent.',
				'x-secret': true,
				'x-scope': 'user',
				'x-widget': 'textarea'
			},
			kubeContext: {
				type: 'string',
				title: 'Context (optional)',
				description: "Defaults to the kubeconfig's current-context."
			},
			namespace: {
				type: 'string',
				title: 'Namespace',
				default: DEFAULT_NAMESPACE
			},
			registry: REGISTRY_SCHEMA,
			ingressClass: {
				type: 'string',
				title: 'Ingress class',
				description: 'Detected at validation time. Leave blank to use the cluster default.'
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
			}
		},
		required: ['kubeconfig']
	};

	private context?: PluginContext;
	private readonly api: KubernetesApiService;
	private readonly registries: RegistryProviderRegistry;
	private readonly ingressStrategies: IngressStrategyRegistry;
	private readonly dnsResolver: DnsResolver;

	constructor(
		opts: {
			api?: KubernetesApiService;
			registries?: RegistryProviderRegistry;
			ingressStrategies?: IngressStrategyRegistry;
			dnsResolver?: DnsResolver;
		} = {}
	) {
		this.api = opts.api ?? new KubernetesApiService();
		this.registries = opts.registries ?? defaultRegistryProviderRegistry;
		this.ingressStrategies = opts.ingressStrategies ?? defaultIngressStrategyRegistry;
		this.dnsResolver = opts.dnsResolver ?? defaultDnsResolver;
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
				includeInOnboarding: false,
				completionFields: ['kubeconfig']
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

	async deploy(config: DeploymentConfig, kubeconfig: string): Promise<DeploymentResult> {
		const settings = await this.loadSettings();
		const namespace = settings.namespace?.trim() || DEFAULT_NAMESPACE;
		const replicas = clampReplicas(settings.replicas);
		const registry = settings.registry ?? { kind: 'github' as const };
		const opts = (config.options ?? {}) as DeployOptions;
		const gitSha = (opts.gitSha ?? Date.now().toString(36)).slice(0, 12);
		const slug = sanitiseSlug(config.projectName);
		const createdAt = new Date().toISOString();

		const provider = this.registries.resolve(registry.kind);
		const registryCtx: RegistryDeployContext = {
			workSlug: slug,
			githubOwner: opts.githubOwner,
			websiteRepoIsPrivate: opts.websiteRepoIsPrivate
		};
		const visibility: ResolvedImageVisibility = provider.resolveVisibility(registry, registryCtx);
		const imageBase = provider.imageBase(registry, registryCtx);
		const image = `${imageBase}/${slug}:${gitSha}`;

		const ingressClass = settings.ingressClass;
		const controller = await this.controllerForClassName(kubeconfig, settings.kubeContext, ingressClass);
		const strategy = this.ingressStrategies.selectStrategy(controller);
		const hosts = this.collectHosts(settings, opts);

		// Pull-secret credentials when needed.
		const pullCreds = provider.pullSecretCredentials(registry, registryCtx, visibility);
		let pullSecretName: string | undefined;

		try {
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

			const renderInputs = {
				workId: config.projectName,
				workSlug: slug,
				namespace,
				image,
				replicas,
				containerPort: CONTAINER_PORT,
				pullSecretName,
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

	async getDeploymentStatus(deploymentId: string, kubeconfig: string): Promise<DeploymentResult> {
		const settings = await this.loadSettings();
		const { namespace, name } = parseDeploymentId(deploymentId);
		const createdAt = new Date().toISOString();

		try {
			const deployment = await this.api.getDeployment(kubeconfig, namespace, name, settings.kubeContext);
			if (!deployment) {
				return { id: deploymentId, status: 'pending', createdAt };
			}
			const status = mapDeploymentToStatus(deployment);
			return {
				id: deploymentId,
				status,
				createdAt,
				completedAt: status === 'ready' || status === 'error' ? new Date().toISOString() : undefined
			};
		} catch (err) {
			const scrubbed = scrubError(err, this.runtimeScrubPatterns({ kubeconfig }));
			return {
				id: deploymentId,
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
		kubeconfig: string
	): Promise<{ found: boolean; website?: string; deploymentState?: string; projectId?: string }> {
		const settings = await this.loadSettings();
		const slug = sanitiseSlug(projectName);
		const namespace = settings.namespace?.trim() || DEFAULT_NAMESPACE;
		try {
			const deployment = await this.api.getDeployment(kubeconfig, namespace, slug, settings.kubeContext);
			if (!deployment) return { found: false };
			return {
				found: true,
				projectId: makeDeploymentId(namespace, slug),
				deploymentState: mapDeploymentToStatus(deployment)
			};
		} catch {
			return { found: false };
		}
	}

	async getDomains(projectId: string, kubeconfig: string): Promise<DeploymentDomain[]> {
		const settings = await this.loadSettings();
		const { namespace, name } = parseDeploymentId(projectId);
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

	async addDomain(projectId: string, domain: string, kubeconfig: string): Promise<AddDomainResult> {
		const settings = await this.loadSettings();
		const { namespace, name } = parseDeploymentId(projectId);
		const controller = await this.controllerForClassName(kubeconfig, settings.kubeContext, settings.ingressClass);
		const strategy = this.ingressStrategies.selectStrategy(controller);

		const existing = (await this.api.readIngress(kubeconfig, namespace, name, settings.kubeContext)) ?? {
			spec: { ingressClassName: settings.ingressClass, rules: [], tls: [] }
		};

		const patched = appendHostToIngress(
			existing as { spec?: { rules?: unknown[]; tls?: unknown[]; ingressClassName?: string } },
			{
				host: domain,
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

	async removeDomain(projectId: string, domain: string, kubeconfig: string): Promise<boolean> {
		const settings = await this.loadSettings();
		const { namespace, name } = parseDeploymentId(projectId);
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

	async verifyDomain(projectId: string, domain: string, kubeconfig: string): Promise<DeploymentDomain> {
		const settings = await this.loadSettings();
		const { namespace, name } = parseDeploymentId(projectId);
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
			K8S_NAMESPACE: cfg.namespace?.trim() || DEFAULT_NAMESPACE
		};
		if (cfg.kubeContext) out.K8S_KUBE_CONTEXT = cfg.kubeContext;
		if (cfg.ingressClass) out.K8S_INGRESS_CLASS = cfg.ingressClass;
		if (cfg.ingressHost) out.K8S_INGRESS_HOST = cfg.ingressHost;
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

	// Helpers ---------------------------------------------------------------

	private async loadSettings(): Promise<KubernetesSettings> {
		if (!this.context) return {};
		const raw = (await this.context.getSettings()) ?? {};
		return this.coerceSettings(raw);
	}

	private coerceSettings(raw: Record<string, unknown>): KubernetesSettings {
		const out: KubernetesSettings = {};
		if (typeof raw.kubeconfig === 'string') out.kubeconfig = raw.kubeconfig;
		if (typeof raw.kubeContext === 'string') out.kubeContext = raw.kubeContext;
		if (typeof raw.namespace === 'string') out.namespace = raw.namespace;
		if (typeof raw.ingressClass === 'string') out.ingressClass = raw.ingressClass;
		if (typeof raw.ingressHost === 'string') out.ingressHost = raw.ingressHost;
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

function sanitiseSlug(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-+/g, '-')
		.slice(0, 63);
}

function clampReplicas(input: number | undefined): number {
	if (typeof input !== 'number' || !Number.isFinite(input)) return DEFAULT_REPLICAS;
	return Math.min(10, Math.max(1, Math.floor(input)));
}

export type { IngressClassDescriptor };
