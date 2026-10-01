import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isAppDeploymentPlugin } from '@ever-works/plugin';
import type {
	AppClusterCheckRequest,
	AppDeployHooks,
	AppDeployResult,
	AppDestroyResult,
	AppJobResult,
	AppJobRunRequest,
	AppLimitRangeInput,
	AppLogRequest,
	AppLogTail,
	AppScaleResult,
	AppStatusSnapshot,
	AppStatusSpec,
	AppTargetRef,
	PluginContext
} from '@ever-works/plugin';
import { KubernetesPlugin } from '../k8s.plugin';
import { KubernetesApiService } from '../k8s-api.service';
import { K8sPluginError } from '../errors';
import type { IngressClassDescriptor, KubernetesClusterInfo } from '../types';
import { AppDeployer } from '../app/app-deployer';
import { AppStatusReader } from '../app/app-status.reader';
import { AppLifecycle, minimalRenderInput } from '../app/app-lifecycle';
import { AppClusterChecker } from '../app/app-cluster-check';
import type { AppClusterCheckReport } from '../app/app-cluster-check';
import type { KubeconfigDnsResolver } from '../app/app-kubeconfig.guard';

const VALID = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-valid.yml'), 'utf-8');
const UNSUPPORTED = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-exec.yml'), 'utf-8');

function createMockContext(settings: Record<string, unknown> = {}): PluginContext {
	return {
		pluginId: 'k8s',
		logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
		cache: {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
			clear: vi.fn()
		} as unknown as PluginContext['cache'],
		http: {} as PluginContext['http'],
		env: {} as PluginContext['env'],
		envVars: {} as PluginContext['envVars'],
		services: {} as PluginContext['services'],
		getSettings: vi.fn().mockResolvedValue(settings),
		getResolvedSettings: vi.fn(),
		updateSettings: vi.fn(),
		onEvent: vi.fn(),
		emitEvent: vi.fn(),
		registerCustomCapability: vi.fn(),
		getCustomCapability: vi.fn()
	} as unknown as PluginContext;
}

function makeMockApi(overrides: Partial<KubernetesApiService> = {}): KubernetesApiService {
	const stub = {
		validateConnection: vi.fn(
			async (_yaml: string, opts: { hasStrategyFor: (c: string) => boolean }) =>
				({
					clusterName: 'kind-dev',
					serverUrl: 'https://kind.example.com:6443',
					serverVersion: 'v1.30.4',
					serverFingerprint: 'abc123def4567890',
					ingressClasses: [
						{
							name: 'nginx',
							controller: 'k8s.io/ingress-nginx',
							isDefault: true,
							hasStrategy: opts.hasStrategyFor('k8s.io/ingress-nginx')
						}
					] as IngressClassDescriptor[],
					requiresExecPlugin: false
				}) satisfies KubernetesClusterInfo
		),
		listIngressClasses: vi.fn(async () => [
			{
				name: 'nginx',
				controller: 'k8s.io/ingress-nginx',
				isDefault: true,
				hasStrategy: true
			}
		]),
		getDeployment: vi.fn(async () => ({
			metadata: { name: 'my-site', namespace: 'ever-works' },
			status: { conditions: [{ type: 'Available', status: 'True' }] }
		})),
		listManagedDeployments: vi.fn(async () => []),
		applyDeployment: vi.fn(async () => undefined),
		applyService: vi.fn(async () => undefined),
		applyIngress: vi.fn(async () => undefined),
		applyImagePullSecret: vi.fn(async () => undefined),
		ensureNamespace: vi.fn(async () => undefined),
		readIngress: vi.fn(async () => ({
			metadata: { name: 'my-site' },
			spec: { ingressClassName: 'nginx', rules: [], tls: [] },
			status: { loadBalancer: { ingress: [{ hostname: 'lb.cluster.example.com' }] } }
		})),
		getIngressLoadBalancerHost: vi.fn(async () => 'lb.cluster.example.com'),
		getServerVersion: vi.fn(async () => 'v1.30.4'),
		...overrides
	};
	return stub as unknown as KubernetesApiService;
}

describe('KubernetesPlugin metadata', () => {
	const plugin = new KubernetesPlugin();

	it('has correct id/name/version', () => {
		expect(plugin.id).toBe('k8s');
		expect(plugin.name).toBe('Kubernetes');
		expect(plugin.version).toBe('1.0.0');
	});

	it('has deployment category and capability', () => {
		expect(plugin.category).toBe('deployment');
		expect(plugin.capabilities).toContain('deployment');
	});

	it('uses user-required configuration mode', () => {
		expect(plugin.configurationMode).toBe('user-required');
	});

	it('manifest is user-only and NOT default-for-deployment (Vercel keeps that)', () => {
		const m = plugin.getManifest();
		expect(m.visibility).toBe('user-only');
		expect(m.defaultForCapabilities).toBeUndefined();
		expect(m.builtIn).toBe(true);
		expect(m.systemPlugin).toBe(true);
	});

	it('settings schema marks kubeconfig as secret and user-scoped textarea', () => {
		const s = plugin.settingsSchema.properties?.kubeconfig as Record<string, unknown>;
		expect(s?.['x-secret']).toBe(true);
		expect(s?.['x-scope']).toBe('user');
		expect(s?.['x-widget']).toBe('textarea');
	});

	it('makes kubeconfig conditionally required only when clusterSource is custom-kubeconfig', () => {
		// Top-level `required` is no longer hard-coded — instead an
		// `allOf` clause requires `kubeconfig` only when the user picked
		// `custom-kubeconfig` (the back-compat default).
		expect(plugin.settingsSchema.required).toBeUndefined();
		const allOf = plugin.settingsSchema.allOf;
		expect(allOf).toHaveLength(1);
		expect(allOf?.[0].then?.required).toEqual(['kubeconfig']);
	});

	it('exposes the cluster-source dropdown enum + admin-aware widget', () => {
		const cs = plugin.settingsSchema.properties?.clusterSource as Record<string, unknown>;
		// `k8s-works-shared` (shared customer cluster) is listed first as the
		// customer default; `k8s-works` (internal cluster) is admin-only.
		expect(cs?.enum).toEqual(['k8s-works-shared', 'k8s-works', 'custom-kubeconfig']);
		expect(cs?.default).toBe('custom-kubeconfig');
		// The dropdown is rendered by the admin-aware `k8s-cluster-source` widget,
		// which hides `k8s-works` from non-admins.
		expect(cs?.['x-widget']).toBe('k8s-cluster-source');
		// The static description must NOT mention the admin-only `k8s-works` as a
		// selectable option (note: `k8s-works-shared` legitimately contains that
		// substring, so match the quoted option token / "internal cluster" copy).
		expect(String(cs?.description)).not.toContain("'k8s-works'");
		expect(String(cs?.description)).not.toMatch(/internal cluster/i);
		expect(String(cs?.description)).toContain('k8s-works-shared');
	});

	it('hides kubeconfig + kubeContext when clusterSource is platform-managed (EW-616 UI)', () => {
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.kubeconfig?.['x-showIf']).toEqual({
			field: 'clusterSource',
			value: 'custom-kubeconfig'
		});
		expect(props.kubeContext?.['x-showIf']).toEqual({
			field: 'clusterSource',
			value: 'custom-kubeconfig'
		});
	});

	it('hides the namespace field for platform-managed sources (server enforces per-tenant namespace)', () => {
		// Owner item #3b — defense-in-depth for the authoritative server-side
		// namespace enforcement: on shared/managed clusters the namespace is
		// assigned per tenant, so the free-text field is hidden and only shown
		// for a user's own cluster (custom-kubeconfig).
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.namespace?.['x-showIf']).toEqual({
			field: 'clusterSource',
			value: 'custom-kubeconfig'
		});
	});

	it('registry sub-form is a oneOf with three branches (github default)', () => {
		const reg = plugin.settingsSchema.properties?.registry as { oneOf?: unknown[]; default?: { kind: string } };
		expect(reg.oneOf).toHaveLength(3);
		expect(reg.default?.kind).toBe('github');
	});

	it('ingressClass field uses the cluster-ingress-class widget so the form can render a dynamic Select', () => {
		const ic = plugin.settingsSchema.properties?.ingressClass as Record<string, unknown>;
		expect(ic?.['x-widget']).toBe('cluster-ingress-class');
	});

	it('publishes measured memory defaults without narrowing Kubernetes quantity syntax', () => {
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.memoryRequest?.default).toBeUndefined();
		expect(props.memoryLimit?.default).toBe('2Gi');
		expect(props.memoryRequest?.pattern).toBeUndefined();
		expect(props.memoryLimit?.pattern).toBeUndefined();
	});

	it('manifest hints verifiesOnSave so the UI labels the save button "Save & verify" and shows cluster info on success', () => {
		const m = plugin.getManifest();
		expect(m.uiHints?.verifiesOnSave).toBe(true);
	});

	it('manifest opts the k8s plugin into onboarding so the Deploy step can route users into the configure form', () => {
		const m = plugin.getManifest();
		expect(m.uiHints?.includeInOnboarding).toBe(true);
		expect(m.uiHints?.onboardingPriority).toBe(4);
		expect(m.uiHints?.onboardingDescription).toBeDefined();
	});
});

describe('KubernetesPlugin.validateSettings', () => {
	const plugin = new KubernetesPlugin();

	it('accepts the managed minimum and preserves smaller requests for custom clusters', () => {
		expect(
			plugin.validateSettings({ clusterSource: 'k8s-works', memoryRequest: '512Mi', memoryLimit: '2Gi' })
		).toEqual({ valid: true });
		expect(
			plugin.validateSettings({ clusterSource: 'k8s-works', memoryRequest: '0.5Gi', memoryLimit: '1e9' })
		).toEqual({ valid: true });
		expect(
			plugin.validateSettings({ clusterSource: 'custom-kubeconfig', memoryRequest: '256Mi', memoryLimit: '2Gi' })
		).toEqual({ valid: true });
		expect(
			plugin.validateSettings({ clusterSource: 'custom-kubeconfig', memoryRequest: '500M', memoryLimit: '1G' })
		).toEqual({ valid: true });
	});

	it('rejects malformed memory quantities on a platform-managed cluster', () => {
		const result = plugin.validateSettings({
			clusterSource: 'k8s-works',
			memoryRequest: 'not-a-quantity',
			memoryLimit: '2Gi'
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: 'memoryRequest', code: 'INVALID_MEMORY_QUANTITY' })
			])
		);
	});

	it('rejects unsupported quantity suffixes on a platform-managed cluster', () => {
		const result = plugin.validateSettings({
			clusterSource: 'k8s-works',
			memoryRequest: '500K',
			memoryLimit: '2Gi'
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: 'memoryRequest', code: 'INVALID_MEMORY_QUANTITY' })
			])
		);
	});

	it('rejects a request larger than the limit', () => {
		const result = plugin.validateSettings({
			clusterSource: 'k8s-works',
			memoryRequest: '3Gi',
			memoryLimit: '2Gi'
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: 'memoryRequest', code: 'MEMORY_REQUEST_EXCEEDS_LIMIT' })
			])
		);
	});

	it('rejects new sub-512Mi requests on platform-managed clusters', () => {
		const result = plugin.validateSettings({
			clusterSource: 'k8s-works-shared',
			memoryRequest: '256Mi',
			memoryLimit: '2Gi'
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: 'memoryRequest', code: 'MANAGED_MEMORY_REQUEST_TOO_LOW' })
			])
		);
	});

	it('validates a legacy low request and low limit as one invalid managed pair', () => {
		const result = plugin.validateSettings({
			clusterSource: 'k8s-works',
			memoryRequest: '256Mi',
			memoryLimit: '384Mi'
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: 'memoryRequest', code: 'MANAGED_MEMORY_REQUEST_TOO_LOW' }),
				expect.objectContaining({ path: 'memoryLimit', code: 'MANAGED_MEMORY_LIMIT_TOO_LOW' })
			])
		);
	});

	it('recognizes valid DecimalSI quantities while applying the managed admission floor', () => {
		const result = plugin.validateSettings({
			clusterSource: 'k8s-works',
			memoryRequest: '500M',
			memoryLimit: '1G'
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: 'memoryRequest', code: 'MANAGED_MEMORY_REQUEST_TOO_LOW' })
			])
		);
		expect(result.errors).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ code: 'INVALID_MEMORY_QUANTITY' })])
		);
	});
});

describe('KubernetesPlugin.validateConnection', () => {
	let plugin: KubernetesPlugin;
	let api: KubernetesApiService;

	beforeEach(() => {
		api = makeMockApi();
		plugin = new KubernetesPlugin({ api });
	});

	it('rejects when kubeconfig is missing', async () => {
		const r = await plugin.validateConnection({});
		expect(r.success).toBe(false);
		expect(r.message).toMatch(/paste a kubeconfig/i);
	});

	it('skips kubeconfig validation for platform-managed cluster sources', async () => {
		const shared = await plugin.validateConnection({ clusterSource: 'k8s-works-shared' });
		expect(shared.success).toBe(true);
		expect(shared.message).toMatch(/platform-managed cluster 'k8s-works-shared'/);
		expect((shared.details as { clusterSource?: string })?.clusterSource).toBe('k8s-works-shared');

		const internal = await plugin.validateConnection({ clusterSource: 'k8s-works' });
		expect(internal.success).toBe(true);
		expect(internal.message).toMatch(/platform-managed cluster 'k8s-works'/);
	});

	it('returns rich cluster details on success', async () => {
		const r = await plugin.validateConnection({ kubeconfig: VALID });
		expect(r.success).toBe(true);
		expect(r.message).toMatch(/kind-dev/);
		expect(r.message).toMatch(/v1\.30\.4/);
		const details = r.details as Record<string, unknown>;
		expect(details.serverFingerprint).toBe('abc123def4567890');
		const classes = details.ingressClasses as IngressClassDescriptor[];
		expect(classes[0].hasStrategy).toBe(true);
	});

	it('scrubs error messages when validation fails', async () => {
		const failing = makeMockApi({
			validateConnection: vi.fn(async () => {
				throw new Error('connection failed: token: leaked-secret-12345');
			})
		});
		const p = new KubernetesPlugin({ api: failing });
		const r = await p.validateConnection({ kubeconfig: VALID });
		expect(r.success).toBe(false);
		expect(r.message).not.toContain('leaked-secret-12345');
		expect(r.message).toContain('[REDACTED]');
	});
});

describe('KubernetesPlugin.validateToken', () => {
	const plugin = new KubernetesPlugin();

	it('returns true for a parseable kubeconfig', async () => {
		expect(await plugin.validateToken(VALID)).toBe(true);
	});

	it('returns false for empty/invalid kubeconfig', async () => {
		expect(await plugin.validateToken('')).toBe(false);
		expect(await plugin.validateToken('not-yaml: ! @')).toBe(false);
	});
});

describe('KubernetesPlugin.getDeploymentSecrets', () => {
	const plugin = new KubernetesPlugin();

	it('always sets K8S_NAMESPACE (defaulting to ever-works)', async () => {
		const out = await plugin.getDeploymentSecrets({});
		expect(out.K8S_NAMESPACE).toBe('ever-works');
	});

	it('emits K8S_CLUSTER_SOURCE (defaulting to custom-kubeconfig for back-compat)', async () => {
		expect((await plugin.getDeploymentSecrets({})).K8S_CLUSTER_SOURCE).toBe('custom-kubeconfig');
		expect((await plugin.getDeploymentSecrets({ clusterSource: 'k8s-works-shared' })).K8S_CLUSTER_SOURCE).toBe(
			'k8s-works-shared'
		);
		expect((await plugin.getDeploymentSecrets({ clusterSource: 'k8s-works' })).K8S_CLUSTER_SOURCE).toBe(
			'k8s-works'
		);
		// Garbage values (and the retired legacy `k8s-gauzy` spelling) fall
		// through to the back-compat default — the plugin only knows the
		// current values; the API-side migration rewrites stored legacy values.
		expect((await plugin.getDeploymentSecrets({ clusterSource: 'nope' })).K8S_CLUSTER_SOURCE).toBe(
			'custom-kubeconfig'
		);
	});

	it('passes optional fields through when set', async () => {
		const out = await plugin.getDeploymentSecrets({
			namespace: 'apps',
			ingressClass: 'nginx',
			ingressHost: 'a.example.com',
			tlsIssuer: 'letsencrypt-prod',
			replicas: 3
		});
		expect(out.K8S_NAMESPACE).toBe('apps');
		expect(out.K8S_INGRESS_CLASS).toBe('nginx');
		expect(out.K8S_INGRESS_HOST).toBe('a.example.com');
		expect(out.K8S_TLS_ISSUER).toBe('letsencrypt-prod');
		expect(out.K8S_REPLICAS).toBe('3');
	});

	it('emits github-specific vars without leaking auth (no GITHUB_TOKEN here)', async () => {
		const out = await plugin.getDeploymentSecrets({
			registry: { kind: 'github', owner: 'acme', visibility: 'auto' }
		});
		expect(out.K8S_REGISTRY_KIND).toBe('github');
		expect(out.K8S_REGISTRY_OWNER).toBe('acme');
		expect(out.K8S_REGISTRY_VISIBILITY).toBe('auto');
		expect(out.GITHUB_TOKEN).toBeUndefined();
		expect(out.REGISTRY_PASSWORD).toBeUndefined();
	});

	it('emits dockerhub username + password as REGISTRY_USERNAME / REGISTRY_PASSWORD', async () => {
		const out = await plugin.getDeploymentSecrets({
			registry: { kind: 'dockerhub', username: 'acme', password: 'mYr3gistryPwD!' }
		});
		expect(out.REGISTRY_USERNAME).toBe('acme');
		expect(out.REGISTRY_PASSWORD).toBe('mYr3gistryPwD!');
	});

	it('emits generic REGISTRY_SERVER alongside username/password', async () => {
		const out = await plugin.getDeploymentSecrets({
			registry: { kind: 'generic', server: 'registry.example.com', username: 'acme', password: 'p' }
		});
		expect(out.REGISTRY_SERVER).toBe('registry.example.com');
		expect(out.REGISTRY_USERNAME).toBe('acme');
		expect(out.REGISTRY_PASSWORD).toBe('p');
	});

	it('does NOT leak the kubeconfig in any returned value', async () => {
		const out = await plugin.getDeploymentSecrets({
			kubeconfig: VALID,
			registry: { kind: 'github' }
		});
		for (const v of Object.values(out)) {
			expect(v).not.toContain('apiVersion: v1');
			expect(v).not.toContain('kind: Config');
		}
	});

	// EW-741 — additional Ingress hosts (custom domains) ride alongside the
	// managed subdomain via `K8S_EXTRA_HOSTS`. The plugin dedupes against the
	// primary, lowercases, drops blanks, and only emits the secret when there
	// is something to say — so existing single-host Works see zero secret
	// churn.
	it('emits K8S_EXTRA_HOSTS (comma-separated, deduped against ingressHost) when extraHosts present', async () => {
		const out = await plugin.getDeploymentSecrets({
			ingressHost: 'managed.example.com',
			extraHosts: ['foo.example.com', 'bar.example.com', 'managed.example.com', 'FOO.example.com']
		});
		expect(out.K8S_INGRESS_HOST).toBe('managed.example.com');
		expect(out.K8S_EXTRA_HOSTS).toBe('foo.example.com,bar.example.com');
	});

	it('does NOT emit K8S_EXTRA_HOSTS when the array is empty or absent', async () => {
		const noExtras = await plugin.getDeploymentSecrets({
			ingressHost: 'managed.example.com'
		});
		expect(noExtras.K8S_EXTRA_HOSTS).toBeUndefined();
		const emptyArray = await plugin.getDeploymentSecrets({
			ingressHost: 'managed.example.com',
			extraHosts: []
		});
		expect(emptyArray.K8S_EXTRA_HOSTS).toBeUndefined();
	});

	it('does NOT emit K8S_EXTRA_HOSTS when every extraHost duplicates the primary', async () => {
		const out = await plugin.getDeploymentSecrets({
			ingressHost: 'managed.example.com',
			extraHosts: ['managed.example.com', '  MANAGED.example.com  ', '']
		});
		expect(out.K8S_EXTRA_HOSTS).toBeUndefined();
	});

	it('drops non-string entries in extraHosts silently', async () => {
		const out = await plugin.getDeploymentSecrets({
			ingressHost: 'managed.example.com',
			// Simulates a malformed settings blob that slipped through.
			extraHosts: ['ok.example.com', null as unknown as string, 42 as unknown as string]
		});
		expect(out.K8S_EXTRA_HOSTS).toBe('ok.example.com');
	});
});

describe('KubernetesPlugin.getWorkflowFilenames', () => {
	it('returns the deploy_k8s workflow filename', () => {
		expect(new KubernetesPlugin().getWorkflowFilenames()).toEqual(['deploy_k8s.yaml']);
	});
});

describe('KubernetesPlugin.deploy (mocked api)', () => {
	let plugin: KubernetesPlugin;
	let api: KubernetesApiService;
	const ctx = createMockContext({
		kubeconfig: VALID,
		namespace: 'ever-works',
		registry: { kind: 'github', visibility: 'auto' }
	});

	beforeEach(async () => {
		api = makeMockApi();
		plugin = new KubernetesPlugin({ api });
		await plugin.onLoad(ctx);
	});

	it('public website repo → no pull secret applied', async () => {
		const result = await plugin.deploy(
			{
				projectName: 'work-1',
				sourceDir: '.',
				options: { gitSha: 'abc1234', githubOwner: 'acme', websiteRepoIsPrivate: false }
			},
			VALID
		);
		expect(result.status).toBe('deploying');
		expect(api.applyImagePullSecret).not.toHaveBeenCalled();
		expect(api.applyDeployment).toHaveBeenCalledTimes(1);
		expect(api.applyService).toHaveBeenCalledTimes(1);
	});

	it('uses the managed kubeconfig current context instead of a stale singleton context', async () => {
		await plugin.onLoad(
			createMockContext({
				kubeContext: 'obsolete-singleton-context',
				registry: { kind: 'github', visibility: 'auto' }
			})
		);

		const result = await plugin.deploy(
			{
				projectName: 'work-1',
				sourceDir: '.',
				options: {
					githubOwner: 'acme',
					websiteRepoIsPrivate: false,
					settingsOverride: { clusterSource: 'k8s-works' },
					kubeContextOverride: null
				}
			},
			VALID
		);

		expect(result.status).toBe('deploying');
		expect(api.ensureNamespace).toHaveBeenCalledWith(VALID, 'ever-works', undefined);
		expect(api.applyDeployment).toHaveBeenCalledWith(VALID, expect.any(Object), undefined);
	});

	it('private website repo + GHCR → applies a pull secret', async () => {
		const result = await plugin.deploy(
			{
				projectName: 'work-1',
				sourceDir: '.',
				options: {
					gitSha: 'abc1234',
					githubOwner: 'acme',
					websiteRepoIsPrivate: true,
					githubReadPackagesToken: 'ghp_fake'
				}
			},
			VALID
		);
		expect(result.status).toBe('deploying');
		expect(api.applyImagePullSecret).toHaveBeenCalledTimes(1);
	});

	it('private GHCR without a read:packages token → status: error (scrubbed)', async () => {
		const result = await plugin.deploy(
			{
				projectName: 'work-1',
				sourceDir: '.',
				options: { gitSha: 'abc1234', githubOwner: 'acme', websiteRepoIsPrivate: true }
			},
			VALID
		);
		expect(result.status).toBe('error');
		expect(result.error).toMatch(/read:packages/i);
		expect(api.applyDeployment).not.toHaveBeenCalled();
	});

	it('apply failures end up as status: error with scrubbed message', async () => {
		const failing = makeMockApi({
			applyDeployment: vi.fn(async () => {
				throw new Error('403 Forbidden — token: leak-12345');
			})
		});
		const p = new KubernetesPlugin({ api: failing });
		await p.onLoad(ctx);
		const result = await p.deploy(
			{ projectName: 'work-1', sourceDir: '.', options: { githubOwner: 'acme', websiteRepoIsPrivate: false } },
			VALID
		);
		expect(result.status).toBe('error');
		expect(result.error).not.toContain('leak-12345');
	});

	it('normalizes a legacy managed 256Mi request to the 512Mi admission floor', async () => {
		await plugin.deploy(
			{
				projectName: 'work-1',
				sourceDir: '.',
				options: {
					githubOwner: 'acme',
					websiteRepoIsPrivate: false,
					settingsOverride: { clusterSource: 'k8s-works', memoryRequest: '256Mi' }
				}
			},
			VALID
		);

		const manifest = vi.mocked(api.applyDeployment).mock.calls[0]?.[1] as Record<string, any>;
		expect(manifest.spec.template.spec.containers[0].resources.requests.memory).toBe('512Mi');
	});

	it('fails before any API write when a legacy managed limit is below the normalized request floor', async () => {
		const result = await plugin.deploy(
			{
				projectName: 'work-1',
				sourceDir: '.',
				options: {
					githubOwner: 'acme',
					websiteRepoIsPrivate: false,
					settingsOverride: {
						clusterSource: 'k8s-works',
						memoryRequest: '256Mi',
						memoryLimit: '384Mi'
					}
				}
			},
			VALID
		);

		expect(result.status).toBe('error');
		expect(result.error).toMatch(/limit.*512Mi admission floor/i);
		expect(api.ensureNamespace).not.toHaveBeenCalled();
		expect(api.applyDeployment).not.toHaveBeenCalled();
	});

	it('preserves an explicit 256Mi request for a custom cluster', async () => {
		await plugin.deploy(
			{
				projectName: 'work-1',
				sourceDir: '.',
				options: {
					githubOwner: 'acme',
					websiteRepoIsPrivate: false,
					settingsOverride: { clusterSource: 'custom-kubeconfig', memoryRequest: '256Mi' }
				}
			},
			VALID
		);

		const manifest = vi.mocked(api.applyDeployment).mock.calls[0]?.[1] as Record<string, any>;
		expect(manifest.spec.template.spec.containers[0].resources.requests.memory).toBe('256Mi');
	});

	it('preserves the historical 256Mi fallback for a custom cluster without an override', async () => {
		await plugin.deploy(
			{
				projectName: 'work-1',
				sourceDir: '.',
				options: {
					githubOwner: 'acme',
					websiteRepoIsPrivate: false,
					settingsOverride: { clusterSource: 'custom-kubeconfig' }
				}
			},
			VALID
		);

		const manifest = vi.mocked(api.applyDeployment).mock.calls[0]?.[1] as Record<string, any>;
		expect(manifest.spec.template.spec.containers[0].resources.requests.memory).toBe('256Mi');
	});
});

describe('KubernetesPlugin.getDeploymentStatus', () => {
	it('uses the authoritative Work target and managed kubeconfig context instead of a stale deployment ID', async () => {
		const api = makeMockApi({
			getDeployment: vi.fn(async (_kubeconfig, namespace, name) => ({
				metadata: { name, namespace },
				status: {
					conditions:
						name === 'repo-a'
							? [{ type: 'Available', status: 'True' }]
							: [{ type: 'Progressing', status: 'False', reason: 'SiblingDeployment' }]
				}
			}))
		});
		const plugin = new KubernetesPlugin({ api });
		await plugin.onLoad(createMockContext({ kubeContext: 'obsolete-singleton-context' }));

		const result = await (plugin as any).getDeploymentStatus('tenant-b/repo-b', VALID, {
			settingsOverride: { clusterSource: 'k8s-works' },
			namespaceOverride: 'tenant-a',
			projectNameOverride: 'repo-a',
			kubeContextOverride: null
		});

		expect(api.getDeployment).toHaveBeenCalledWith(VALID, 'tenant-a', 'repo-a', undefined);
		expect(result.id).toBe('tenant-a/repo-a');
		expect(result.status).toBe('ready');
	});

	it('maps Available=True to ready', async () => {
		const api = makeMockApi();
		const plugin = new KubernetesPlugin({ api });
		const r = await plugin.getDeploymentStatus('ever-works/my-site', VALID);
		expect(r.status).toBe('ready');
	});

	it('returns pending when the Deployment is missing', async () => {
		const api = makeMockApi({ getDeployment: vi.fn(async () => null) });
		const plugin = new KubernetesPlugin({ api });
		const r = await plugin.getDeploymentStatus('ever-works/my-site', VALID);
		expect(r.status).toBe('pending');
	});
});

describe('KubernetesPlugin.lookupExistingDeployment', () => {
	it('uses the authoritative Work repository when the positional project name is stale', async () => {
		const api = makeMockApi({
			getDeployment: vi.fn(async (_kubeconfig, namespace, name) => ({
				metadata: { name, namespace },
				status: {
					conditions:
						name === 'current-website-repo'
							? [{ type: 'Progressing', status: 'True' }]
							: [{ type: 'Available', status: 'True' }],
					replicas: 1
				}
			})),
			readIngress: vi.fn(async (_kubeconfig, _namespace, name) => ({
				metadata: { name },
				spec: { rules: [{ host: `${name}.example.com` }] }
			}))
		});
		const plugin = new KubernetesPlugin({ api });

		const result = await plugin.lookupExistingDeployment('stale-sibling-repo', VALID, undefined, {
			namespaceOverride: 'current-tenant-ns',
			projectNameOverride: 'current-website-repo'
		});

		expect(api.getDeployment).toHaveBeenCalledWith(VALID, 'current-tenant-ns', 'current-website-repo', undefined);
		expect(api.readIngress).toHaveBeenCalledWith(VALID, 'current-tenant-ns', 'current-website-repo', undefined);
		expect(result).toEqual({
			found: true,
			projectId: 'current-tenant-ns/current-website-repo',
			website: 'https://current-website-repo.example.com',
			deploymentState: 'BUILDING'
		});
	});

	it('uses the managed kubeconfig current context instead of a stale singleton context', async () => {
		const api = makeMockApi();
		const plugin = new KubernetesPlugin({ api });
		await plugin.onLoad(createMockContext({ kubeContext: 'obsolete-singleton-context' }));

		await plugin.lookupExistingDeployment('my-site', VALID, undefined, {
			settingsOverride: { clusterSource: 'k8s-works' },
			namespaceOverride: 'ever-works-my-site-prod',
			kubeContextOverride: null
		} as any);

		expect(api.getDeployment).toHaveBeenCalledWith(VALID, 'ever-works-my-site-prod', 'my-site', undefined);
	});

	it('propagates typed cluster/auth failures instead of reporting not-found', async () => {
		const failure = new K8sPluginError('UNAUTHORIZED', 'Kubernetes credentials were rejected.');
		const api = makeMockApi({ getDeployment: vi.fn(async () => Promise.reject(failure)) });
		const plugin = new KubernetesPlugin({ api });

		await expect(plugin.lookupExistingDeployment('my-site', VALID)).rejects.toBe(failure);
	});

	it('uses the Work-scoped namespace and context instead of singleton defaults', async () => {
		const api = makeMockApi();
		const plugin = new KubernetesPlugin({ api });
		await plugin.onLoad(
			createMockContext({ namespace: 'ever-works-shared-default', kubeContext: 'shared-context' })
		);

		const result = await plugin.lookupExistingDeployment('my-site', VALID, undefined, {
			settingsOverride: {
				namespace: 'ever-works-timetrack-prod',
				kubeContext: 'work-context'
			},
			namespaceOverride: 'ever-works-timetrack-prod'
		});

		expect(api.getDeployment).toHaveBeenCalledWith(VALID, 'ever-works-timetrack-prod', 'my-site', 'work-context');
		expect(api.readIngress).toHaveBeenCalledWith(VALID, 'ever-works-timetrack-prod', 'my-site', 'work-context');
		expect(result.projectId).toBe('ever-works-timetrack-prod/my-site');
	});

	it('returns verifier-compatible terminal state and ingress website URL', async () => {
		const api = makeMockApi({
			readIngress: vi.fn(async () => ({
				metadata: { name: 'my-site' },
				spec: { rules: [{ host: 'my-site.example.com' }] },
				status: { loadBalancer: { ingress: [{ hostname: 'lb.cluster.example.com' }] } }
			}))
		});
		const plugin = new KubernetesPlugin({ api });

		const result = await plugin.lookupExistingDeployment('my-site', VALID);

		expect(result).toEqual({
			found: true,
			projectId: 'ever-works/my-site',
			website: 'https://my-site.example.com',
			deploymentState: 'READY'
		});
	});

	it('maps in-progress Kubernetes rollout state to the verifier BUILDING state', async () => {
		const api = makeMockApi({
			getDeployment: vi.fn(async () => ({
				metadata: { name: 'my-site', namespace: 'ever-works' },
				status: { conditions: [{ type: 'Progressing', status: 'True' }], replicas: 1 }
			}))
		});
		const plugin = new KubernetesPlugin({ api });

		const result = await plugin.lookupExistingDeployment('my-site', VALID);

		expect(result.found).toBe(true);
		expect(result.deploymentState).toBe('BUILDING');
	});

	it('does not fail lookup when the deployment has no ingress yet', async () => {
		const api = makeMockApi({ readIngress: vi.fn(async () => null) });
		const plugin = new KubernetesPlugin({ api });

		const result = await plugin.lookupExistingDeployment('my-site', VALID);

		expect(result.found).toBe(true);
		expect(result.website).toBeUndefined();
		expect(result.deploymentState).toBe('READY');
	});

	it('propagates typed ingress connectivity failures after finding the deployment', async () => {
		const failure = new K8sPluginError('CLUSTER_UNREACHABLE', 'Ingress API is unreachable.');
		const api = makeMockApi({ readIngress: vi.fn(async () => Promise.reject(failure)) });
		const plugin = new KubernetesPlugin({ api });

		await expect(plugin.lookupExistingDeployment('my-site', VALID)).rejects.toBe(failure);
	});
});

describe('KubernetesPlugin Work-scoped domain context', () => {
	const scopedContext = {
		settingsOverride: {
			kubeContext: 'work-context',
			ingressClass: 'nginx'
		},
		namespaceOverride: 'current-tenant-ns',
		projectNameOverride: 'current-website-repo'
	};

	it('uses the managed kubeconfig current context for domain operations', async () => {
		const api = makeMockApi();
		const plugin = new KubernetesPlugin({ api });
		await plugin.onLoad(createMockContext({ kubeContext: 'obsolete-singleton-context' }));

		await (plugin as any).getDomains('stale-ns/stale-site', VALID, undefined, {
			settingsOverride: { clusterSource: 'k8s-works-shared' },
			namespaceOverride: 'current-tenant-ns',
			projectNameOverride: 'current-website-repo',
			kubeContextOverride: null
		});

		expect(api.readIngress).toHaveBeenCalledWith(VALID, 'current-tenant-ns', 'current-website-repo', undefined);
	});

	it('uses the Work kubeContext when listing domains', async () => {
		const api = makeMockApi();
		const plugin = new KubernetesPlugin({ api });
		await plugin.onLoad(createMockContext({ kubeContext: 'obsolete-singleton-context' }));

		await (plugin as any).getDomains('stale-tenant-ns/stale-site', VALID, undefined, scopedContext);

		expect(api.readIngress).toHaveBeenCalledWith(
			VALID,
			'current-tenant-ns',
			'current-website-repo',
			'work-context'
		);
	});

	it('uses the Work kubeContext when adding a domain', async () => {
		const api = makeMockApi();
		const plugin = new KubernetesPlugin({ api });
		await plugin.onLoad(createMockContext({ kubeContext: 'obsolete-singleton-context' }));

		await (plugin as any).addDomain(
			'stale-tenant-ns/stale-site',
			'tools.example.com',
			VALID,
			undefined,
			scopedContext
		);

		expect(api.listIngressClasses).toHaveBeenCalledWith(VALID, expect.any(Function), 'work-context');
		expect(api.readIngress).toHaveBeenCalledWith(
			VALID,
			'current-tenant-ns',
			'current-website-repo',
			'work-context'
		);
		expect(api.applyIngress).toHaveBeenCalledWith(VALID, expect.any(Object), 'work-context');
		expect(api.applyIngress).toHaveBeenCalledWith(
			VALID,
			expect.objectContaining({
				metadata: { name: 'current-website-repo', namespace: 'current-tenant-ns' }
			}),
			'work-context'
		);
	});

	it('uses the Work kubeContext when removing a domain', async () => {
		const api = makeMockApi();
		const plugin = new KubernetesPlugin({ api });
		await plugin.onLoad(createMockContext({ kubeContext: 'obsolete-singleton-context' }));

		await (plugin as any).removeDomain(
			'stale-tenant-ns/stale-site',
			'tools.example.com',
			VALID,
			undefined,
			scopedContext
		);

		expect(api.listIngressClasses).toHaveBeenCalledWith(VALID, expect.any(Function), 'work-context');
		expect(api.readIngress).toHaveBeenCalledWith(
			VALID,
			'current-tenant-ns',
			'current-website-repo',
			'work-context'
		);
		expect(api.applyIngress).toHaveBeenCalledWith(VALID, expect.any(Object), 'work-context');
		expect(api.applyIngress).toHaveBeenCalledWith(
			VALID,
			expect.objectContaining({
				metadata: { name: 'current-website-repo', namespace: 'current-tenant-ns' }
			}),
			'work-context'
		);
	});

	it('uses the Work kubeContext when verifying a domain', async () => {
		const api = makeMockApi();
		const plugin = new KubernetesPlugin({
			api,
			dnsResolver: {
				resolveCname: vi.fn(async () => ['lb.cluster.example.com']),
				resolve4: vi.fn(async () => [])
			}
		});
		await plugin.onLoad(createMockContext({ kubeContext: 'obsolete-singleton-context' }));

		await (plugin as any).verifyDomain(
			'stale-tenant-ns/stale-site',
			'tools.example.com',
			VALID,
			undefined,
			scopedContext
		);

		expect(api.getIngressLoadBalancerHost).toHaveBeenCalledWith(
			VALID,
			'current-tenant-ns',
			'current-website-repo',
			'work-context'
		);
	});
});

describe('KubernetesPlugin.getTeams', () => {
	it('returns an empty list (k8s has no team concept)', async () => {
		expect(await new KubernetesPlugin().getTeams('whatever')).toEqual([]);
	});
});

/* ------------------------------------------------------------------------- *
 * APW-06 T14 — the App members: `supportsApps` and the nine delegating
 * methods, each of which runs §6.1's guard over the credential it is given.
 * ------------------------------------------------------------------------- */

/**
 * The address the injected §6.1 resolver answers with. Public, so the guard's
 * `resolvePublicAddresses` step succeeds without touching the network — the same
 * reason T11's own spec injects a resolver (every spec in this repo stays offline).
 */
let clusterAddress = '93.184.216.34';

/** The §6.1 step-2/3 seam the plugin exposes as `clusterAddressResolver`. */
const clusterAddressResolver: KubeconfigDnsResolver = async (hostname) => {
	if (hostname !== 'kind.example.com') {
		throw new Error(`no answer for '${hostname}'`);
	}
	return [{ address: clusterAddress, family: 4 }];
};

function appPlugin(overrides: Partial<KubernetesApiService> = {}): KubernetesPlugin {
	return new KubernetesPlugin({ api: makeMockApi(overrides), clusterAddressResolver });
}

const APP_REF: AppTargetRef = {
	workId: 'work_1',
	namespace: 'ew-timetrack-1a2b3c4d',
	target: 'your-cluster',
	kubeContext: 'kind-dev'
};

const APP_STATUS_SPEC: AppStatusSpec = {
	components: [{ name: 'web', role: 'web', replicas: 1, primary: true }],
	jobs: ['migrate'],
	cron: ['tick']
};

const APP_CLUSTER_CHECK_REQUEST: AppClusterCheckRequest = {
	namespace: APP_REF.namespace,
	needsCreateNamespace: false
};

const APP_JOB_RUN: AppJobRunRequest = {
	name: 'migrate',
	image: `ghcr.io/acme/timetrack@sha256:${'a'.repeat(64)}`
};

const APP_LOG_REQUEST: AppLogRequest = { component: 'web', lines: 200, secretValues: {} };

const APP_NAMESPACE_OPTS = {
	isolation: true,
	limitRange: {
		defaultRequest: { cpu: '100m', memory: '128Mi' },
		defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
		max: { cpu: '8', memory: '64Gi' }
	}
} satisfies { isolation: boolean; limitRange: AppLimitRangeInput };

const APP_PUBLISH_HOSTS = {
	primary: 'timetrack.example.com',
	extra: ['www.timetrack.example.com'],
	previous: [],
	tls: 'cert-manager',
	issuer: 'letsencrypt-prod'
};

const APP_HOOKS: AppDeployHooks = {
	onPhase: vi.fn(async () => undefined),
	verifyPublic: vi.fn(async () => ({ checks: [], passed: true })),
	isCancelled: vi.fn(async () => false)
};

/*
 * The collaborators' answers. T12/T13 are the subject of their own specs; here
 * each value only has to arrive back at the caller untouched.
 */
const APP_DEPLOY_RESULT = {
	outcome: 'succeeded',
	warnings: [],
	components: [],
	jobs: [],
	smoke: { inCluster: [], public: [], observedAt: '2026-09-17T00:00:00.000Z' },
	ingressAddress: { hostname: 'lb.cluster.example.com' },
	isolationEnforced: null,
	firstDeployJobsCompleted: true
} satisfies AppDeployResult;

const APP_STATUS_SNAPSHOT = {
	observedAt: '2026-09-17T00:00:00.000Z',
	components: [{ name: 'web', role: 'web', desired: 1, ready: 1, restarts: 0 }],
	jobs: [],
	cron: [],
	isolationEnforced: null,
	ingressAddress: { hostname: 'lb.cluster.example.com' }
} satisfies AppStatusSnapshot;

const APP_JOB_RESULT = {
	name: 'migrate',
	when: 'pre-deploy',
	runName: 'migrate-1a2b3c4d',
	status: 'succeeded',
	startedAt: '2026-09-17T00:00:00.000Z'
} satisfies AppJobResult;

const APP_DESTROY_RESULT = {
	deleted: [],
	kept: [{ kind: 'PersistentVolumeClaim', name: 'data' }],
	namespaceDeleted: false
} satisfies AppDestroyResult;

const APP_SCALE_RESULT = {
	components: [{ name: 'web', role: 'web', desired: 1, ready: 1, restarts: 0 }],
	smoke: null
} satisfies AppScaleResult;

const APP_LOG_TAIL = {
	containers: [{ pod: 'web-abc', container: 'web', lines: ['listening'], truncated: false }],
	redactedNames: [],
	fetchedAt: '2026-09-17T00:00:00.000Z'
} satisfies AppLogTail;

const APP_PREPARE_WARNINGS = { warnings: [{ code: 'limitrange_forbidden', message: 'skipped' }] };

const APP_PUBLISH_RESULT = { ingressAddress: { hostname: 'lb.cluster.example.com' } };

const APP_CLUSTER_CHECK_REPORT = {
	ok: true,
	serverVersion: 'v1.30.4',
	fingerprint: 'abc123def4567890',
	missingPermissions: [],
	optionalMissing: [],
	ingressClasses: [{ name: 'nginx', isDefault: true }],
	controllerNamespace: 'ingress-nginx',
	clusterIssuers: ['letsencrypt-prod'],
	storageClasses: [{ name: 'standard', isDefault: true }],
	ingressAddress: { hostname: 'lb.cluster.example.com' }
} satisfies AppClusterCheckReport;

/** One App method, ready to be called with the credential its case supplies. */
interface AppCall {
	label: string;
	run(): Promise<unknown>;
}

function refAppCalls(plugin: KubernetesPlugin, ref: AppTargetRef, credential: string): AppCall[] {
	return [
		{ label: 'deployApp', run: () => plugin.deployApp(minimalRenderInput(ref), credential, APP_HOOKS) },
		{ label: 'getAppStatus', run: () => plugin.getAppStatus(ref, credential, APP_STATUS_SPEC) },
		{ label: 'runAppJob', run: () => plugin.runAppJob(ref, credential, APP_JOB_RUN) },
		{ label: 'destroyApp', run: () => plugin.destroyApp(ref, credential, { deleteVolumes: false }) },
		{ label: 'scaleApp', run: () => plugin.scaleApp(ref, credential, 'pause', { web: 0 }) },
		{ label: 'getAppLogs', run: () => plugin.getAppLogs(ref, credential, APP_LOG_REQUEST) },
		{ label: 'prepareAppNamespace', run: () => plugin.prepareAppNamespace(ref, credential, APP_NAMESPACE_OPTS) },
		{ label: 'publishAppHosts', run: () => plugin.publishAppHosts(ref, credential, APP_PUBLISH_HOSTS) }
	];
}

/** Every App method — the nine of the contract (`checkAppCluster` takes no ref). */
function appCalls(plugin: KubernetesPlugin, ref: AppTargetRef, credential: string): AppCall[] {
	return [
		...refAppCalls(plugin, ref, credential),
		{ label: 'checkAppCluster', run: () => plugin.checkAppCluster(credential, APP_CLUSTER_CHECK_REQUEST) }
	];
}

/**
 * Every collaborator, spied. Spying on the module's own prototype is what makes
 * "the plugin delegates, and the module is what does the work" assertable without
 * a second implementation: the plugin's own body is the only thing under test.
 */
function spyOnAppCollaborators() {
	return [
		vi.spyOn(AppDeployer.prototype, 'deployApp').mockResolvedValue(APP_DEPLOY_RESULT),
		vi.spyOn(AppStatusReader.prototype, 'getAppStatus').mockResolvedValue(APP_STATUS_SNAPSHOT),
		vi.spyOn(AppLifecycle.prototype, 'runAppJob').mockResolvedValue(APP_JOB_RESULT),
		vi.spyOn(AppLifecycle.prototype, 'destroyApp').mockResolvedValue(APP_DESTROY_RESULT),
		vi.spyOn(AppLifecycle.prototype, 'scaleApp').mockResolvedValue(APP_SCALE_RESULT),
		vi.spyOn(AppLifecycle.prototype, 'getAppLogs').mockResolvedValue(APP_LOG_TAIL),
		vi.spyOn(AppLifecycle.prototype, 'prepareAppNamespace').mockResolvedValue(APP_PREPARE_WARNINGS),
		vi.spyOn(AppLifecycle.prototype, 'publishAppHosts').mockResolvedValue(APP_PUBLISH_RESULT),
		vi.spyOn(AppClusterChecker.prototype, 'checkAppCluster').mockResolvedValue(APP_CLUSTER_CHECK_REPORT)
	];
}

function expectNoCollaboratorRan(spies: ReturnType<typeof spyOnAppCollaborators>): void {
	for (const spy of spies) {
		expect(spy).not.toHaveBeenCalled();
	}
}

/**
 * §6.1 step 4: what a collaborator receives is the **pinned rewrite**, not the
 * kubeconfig the caller handed in — `kind.example.com` is gone from `server:`,
 * so the client cannot re-resolve between the check and the call.
 */
function expectPinnedCredential(credential: string): void {
	expect(credential).toContain('server: https://93.184.216.34:6443');
	expect(credential).toContain('tls-server-name: kind.example.com');
}

describe('KubernetesPlugin App members (APW-06 T14)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		clusterAddress = '93.184.216.34';
	});

	it('declares supportsApps so isAppDeploymentPlugin narrows it to an App provider', () => {
		const plugin = new KubernetesPlugin();

		expect(plugin.supportsApps).toBe(true);
		expect(isAppDeploymentPlugin(plugin)).toBe(true);
	});

	it('delegates deployApp to AppDeployer with the pinned credential and the hooks', async () => {
		const plugin = appPlugin();
		const spy = vi.spyOn(AppDeployer.prototype, 'deployApp').mockResolvedValue(APP_DEPLOY_RESULT);
		const input = minimalRenderInput(APP_REF);

		const result = await plugin.deployApp(input, VALID, APP_HOOKS);

		expect(spy).toHaveBeenCalledTimes(1);
		const [gotInput, gotCredential, gotHooks] = spy.mock.calls[0];
		expect(gotInput).toBe(input);
		expect(gotHooks).toBe(APP_HOOKS);
		expectPinnedCredential(gotCredential);
		expect(result).toBe(APP_DEPLOY_RESULT);
	});

	it('delegates getAppStatus to AppStatusReader with the pinned credential and the spec', async () => {
		const plugin = appPlugin();
		const spy = vi.spyOn(AppStatusReader.prototype, 'getAppStatus').mockResolvedValue(APP_STATUS_SNAPSHOT);

		const result = await plugin.getAppStatus(APP_REF, VALID, APP_STATUS_SPEC);

		expect(spy).toHaveBeenCalledTimes(1);
		const [gotRef, gotCredential, gotSpec] = spy.mock.calls[0];
		expect(gotRef).toBe(APP_REF);
		expect(gotSpec).toBe(APP_STATUS_SPEC);
		expectPinnedCredential(gotCredential);
		expect(result).toBe(APP_STATUS_SNAPSHOT);
	});

	it('delegates runAppJob to AppLifecycle with the pinned credential and the request', async () => {
		const plugin = appPlugin();
		const spy = vi.spyOn(AppLifecycle.prototype, 'runAppJob').mockResolvedValue(APP_JOB_RESULT);

		const result = await plugin.runAppJob(APP_REF, VALID, APP_JOB_RUN);

		expect(spy).toHaveBeenCalledTimes(1);
		const [gotRef, gotCredential, gotJob] = spy.mock.calls[0];
		expect(gotRef).toBe(APP_REF);
		expect(gotJob).toBe(APP_JOB_RUN);
		expectPinnedCredential(gotCredential);
		expect(result).toBe(APP_JOB_RESULT);
	});

	it('delegates destroyApp to AppLifecycle with the pinned credential and deleteVolumes', async () => {
		const plugin = appPlugin();
		const spy = vi.spyOn(AppLifecycle.prototype, 'destroyApp').mockResolvedValue(APP_DESTROY_RESULT);

		const result = await plugin.destroyApp(APP_REF, VALID, { deleteVolumes: false });

		expect(spy).toHaveBeenCalledTimes(1);
		const [gotRef, gotCredential, gotOpts] = spy.mock.calls[0];
		expect(gotRef).toBe(APP_REF);
		expect(gotOpts).toEqual({ deleteVolumes: false });
		expectPinnedCredential(gotCredential);
		expect(result).toBe(APP_DESTROY_RESULT);
	});

	it('delegates scaleApp to AppLifecycle with the mode, the replicas and the resume checks', async () => {
		const plugin = appPlugin();
		const spy = vi.spyOn(AppLifecycle.prototype, 'scaleApp').mockResolvedValue(APP_SCALE_RESULT);
		const resumeChecks = { smoke: [], deadlines: { web: 300 } };

		const result = await plugin.scaleApp(APP_REF, VALID, 'resume', { web: 2 }, resumeChecks);

		expect(spy).toHaveBeenCalledTimes(1);
		const [gotRef, gotCredential, gotMode, gotReplicas, gotChecks] = spy.mock.calls[0];
		expect(gotRef).toBe(APP_REF);
		expect(gotMode).toBe('resume');
		expect(gotReplicas).toEqual({ web: 2 });
		expect(gotChecks).toBe(resumeChecks);
		expectPinnedCredential(gotCredential);
		expect(result).toBe(APP_SCALE_RESULT);
	});

	it('delegates getAppLogs to AppLifecycle with the pinned credential and the request', async () => {
		const plugin = appPlugin();
		const spy = vi.spyOn(AppLifecycle.prototype, 'getAppLogs').mockResolvedValue(APP_LOG_TAIL);

		const result = await plugin.getAppLogs(APP_REF, VALID, APP_LOG_REQUEST);

		expect(spy).toHaveBeenCalledTimes(1);
		const [gotRef, gotCredential, gotRequest] = spy.mock.calls[0];
		expect(gotRef).toBe(APP_REF);
		expect(gotRequest).toBe(APP_LOG_REQUEST);
		expectPinnedCredential(gotCredential);
		expect(result).toBe(APP_LOG_TAIL);
	});

	it('delegates prepareAppNamespace to AppLifecycle with the pinned credential and the options', async () => {
		const plugin = appPlugin();
		const spy = vi.spyOn(AppLifecycle.prototype, 'prepareAppNamespace').mockResolvedValue(APP_PREPARE_WARNINGS);

		const result = await plugin.prepareAppNamespace(APP_REF, VALID, APP_NAMESPACE_OPTS);

		expect(spy).toHaveBeenCalledTimes(1);
		const [gotRef, gotCredential, gotOpts] = spy.mock.calls[0];
		expect(gotRef).toBe(APP_REF);
		expect(gotOpts).toBe(APP_NAMESPACE_OPTS);
		expectPinnedCredential(gotCredential);
		expect(result).toBe(APP_PREPARE_WARNINGS);
	});

	it('delegates publishAppHosts to AppLifecycle with the pinned credential and the hosts', async () => {
		const plugin = appPlugin();
		const spy = vi.spyOn(AppLifecycle.prototype, 'publishAppHosts').mockResolvedValue(APP_PUBLISH_RESULT);

		const result = await plugin.publishAppHosts(APP_REF, VALID, APP_PUBLISH_HOSTS);

		expect(spy).toHaveBeenCalledTimes(1);
		const [gotRef, gotCredential, gotHosts] = spy.mock.calls[0];
		expect(gotRef).toBe(APP_REF);
		expect(gotHosts).toBe(APP_PUBLISH_HOSTS);
		expectPinnedCredential(gotCredential);
		expect(result).toBe(APP_PUBLISH_RESULT);
	});

	it('delegates checkAppCluster to AppClusterChecker and returns its ingressAddress (GAP-09)', async () => {
		const plugin = appPlugin();
		const spy = vi
			.spyOn(AppClusterChecker.prototype, 'checkAppCluster')
			.mockResolvedValue(APP_CLUSTER_CHECK_REPORT);

		const result = await plugin.checkAppCluster(VALID, APP_CLUSTER_CHECK_REQUEST);

		expect(spy).toHaveBeenCalledTimes(1);
		const [gotCredential, gotRequest] = spy.mock.calls[0];
		expect(gotRequest).toBe(APP_CLUSTER_CHECK_REQUEST);
		expectPinnedCredential(gotCredential);
		expect(result).toBe(APP_CLUSTER_CHECK_REPORT);
		// The report T13 returns is a superset of the frozen `AppClusterCheck`; the address
		// survives the plugin boundary rather than being narrowed away.
		expect(result.ingressAddress).toEqual({ hostname: 'lb.cluster.example.com' });
	});

	it('runs assertSupportedKubeconfig on every App method: an unsupported credential is refused', async () => {
		const plugin = appPlugin();
		const spies = spyOnAppCollaborators();

		for (const { label, run } of appCalls(plugin, APP_REF, UNSUPPORTED)) {
			await expect(run(), label).rejects.toMatchObject({ code: 'KUBECONFIG_UNSUPPORTED' });
		}

		expectNoCollaboratorRan(spies);
	});

	it('runs pinKubeconfigServer on every App method: a private address is refused (FR-4)', async () => {
		const plugin = appPlugin();
		const spies = spyOnAppCollaborators();
		clusterAddress = '10.0.0.1';

		for (const { label, run } of appCalls(plugin, APP_REF, VALID)) {
			await expect(run(), label).rejects.toMatchObject({ code: 'CLUSTER_ADDRESS_NOT_PUBLIC' });
		}

		expectNoCollaboratorRan(spies);
	});

	it('refuses an AppTargetRef whose target is ever-works-apps on every ref-taking method (R-5)', async () => {
		const plugin = appPlugin();
		const spies = spyOnAppCollaborators();
		const ref: AppTargetRef = { ...APP_REF, target: 'ever-works-apps' };

		for (const { label, run } of refAppCalls(plugin, ref, VALID)) {
			await expect(run(), label).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
		}

		expectNoCollaboratorRan(spies);
	});

	it('names the managed target and the plugin that does serve it', async () => {
		const plugin = appPlugin();

		await expect(
			plugin.getAppStatus({ ...APP_REF, target: 'ever-works-apps' }, VALID, APP_STATUS_SPEC)
		).rejects.toThrow(/'ever-works-apps'.*apps-tier/s);
	});

	it('refuses target none too — this plugin serves your-cluster only', async () => {
		const plugin = appPlugin();

		await expect(plugin.getAppLogs({ ...APP_REF, target: 'none' }, VALID, APP_LOG_REQUEST)).rejects.toMatchObject({
			code: 'NOT_CONFIGURED'
		});
	});

	it('keeps serving your-cluster (the ref the deploy orchestrator actually routes here)', async () => {
		const plugin = appPlugin();
		const spy = vi.spyOn(AppStatusReader.prototype, 'getAppStatus').mockResolvedValue(APP_STATUS_SNAPSHOT);

		await expect(plugin.getAppStatus(APP_REF, VALID, APP_STATUS_SPEC)).resolves.toBe(APP_STATUS_SNAPSHOT);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	/**
	 * The verification expiry (added 2026-09-18 with the contract member). §4.12:646-647 puts
	 * `ever-works.io/expires-at` on a verification namespace, and §4.12:659-660 says APW-04's
	 * sweep reads it to clean up leftovers — so the read must answer the ANNOTATION, and must
	 * answer `null` rather than guessing when there is none or when the namespace is unreadable.
	 */
	it('reads the verification expiry annotation from the namespace, verbatim', async () => {
		const readObject = vi.fn(async () => ({
			metadata: { annotations: { 'ever-works.io/expires-at': '2026-09-19T10:00:00Z' } }
		}));
		const plugin = appPlugin({ readObject } as Partial<KubernetesApiService>);

		await expect(plugin.readNamespaceExpiry(APP_REF, VALID)).resolves.toBe('2026-09-19T10:00:00Z');
		expect(readObject).toHaveBeenCalledTimes(1);
		// The read is the cluster-scoped one (`''` namespace argument), the same call shape the
		// status reader uses, and it is handed the PINNED credential — not the raw one.
		const [credential, apiVersion, kind, namespaceArg, name] = readObject.mock.calls[0] as unknown as string[];
		expect(credential).toContain('server: https://93.184.216.34:6443');
		expect(apiVersion).toBe('v1');
		expect(kind).toBe('Namespace');
		expect(namespaceArg).toBe('');
		expect(name).toBe(APP_REF.namespace);
	});

	it('answers null — never a computed instant — when the namespace declares no expiry', async () => {
		const plugin = appPlugin({
			readObject: vi.fn(async () => ({ metadata: { annotations: {} } }))
		} as Partial<KubernetesApiService>);

		await expect(plugin.readNamespaceExpiry(APP_REF, VALID)).resolves.toBeNull();
	});

	it('answers null rather than throwing when the namespace cannot be read', async () => {
		// A status report is not the place to fail a sweep: the caller's documented answer for
		// "no expiry known" is a warning plus an empty value, so an unreadable namespace must not
		// turn a verification-status call into an exception.
		const plugin = appPlugin({
			readObject: vi.fn(async () => {
				throw new Error('namespace read failed');
			})
		} as Partial<KubernetesApiService>);

		await expect(plugin.readNamespaceExpiry(APP_REF, VALID)).resolves.toBeNull();
	});

	it('refuses an ever-works-apps ref for the expiry read too (R-5, every App method)', async () => {
		const plugin = appPlugin();
		const readObject = vi.fn();

		await expect(
			plugin.readNamespaceExpiry({ ...APP_REF, target: 'ever-works-apps' }, VALID)
		).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
		expect(readObject).not.toHaveBeenCalled();
	});
});

describe('KubernetesPlugin.deploy() manifest snapshot (ACC-06-43)', () => {
	it('renders the same Deployment, Service and Ingress for the existing fixture', async () => {
		const api = makeMockApi();
		const plugin = new KubernetesPlugin({ api });
		await plugin.onLoad(
			createMockContext({
				kubeconfig: VALID,
				namespace: 'ever-works',
				ingressHost: 'work-1.example.com',
				ingressClass: 'nginx',
				tlsIssuer: 'letsencrypt-prod',
				registry: { kind: 'github', visibility: 'auto' }
			})
		);

		const result = await plugin.deploy(
			{
				projectName: 'work-1',
				sourceDir: '.',
				options: {
					gitSha: 'abc1234',
					githubOwner: 'acme',
					websiteRepoIsPrivate: false,
					// The pod annotation is otherwise `t<Date.now()>`; pinning it keeps this
					// snapshot a statement about what `deploy()` renders, not about the clock.
					revision: 'rev-abc1234'
				}
			},
			VALID
		);

		expect(result.status).toBe('deploying');
		expect({
			deployment: vi.mocked(api.applyDeployment).mock.calls[0]?.[1],
			service: vi.mocked(api.applyService).mock.calls[0]?.[1],
			ingress: vi.mocked(api.applyIngress).mock.calls[0]?.[1]
		}).toMatchInlineSnapshot(`
			{
			  "deployment": {
			    "apiVersion": "apps/v1",
			    "kind": "Deployment",
			    "metadata": {
			      "labels": {
			        "app.kubernetes.io/managed-by": "ever-works-k8s-plugin",
			        "app.kubernetes.io/name": "work-1",
			        "ever-works.io/managed": "true",
			        "ever-works.io/work-id": "work-1",
			      },
			      "name": "work-1",
			      "namespace": "ever-works",
			    },
			    "spec": {
			      "replicas": 1,
			      "selector": {
			        "matchLabels": {
			          "app.kubernetes.io/name": "work-1",
			        },
			      },
			      "strategy": {
			        "rollingUpdate": {
			          "maxSurge": 0,
			          "maxUnavailable": 1,
			        },
			        "type": "RollingUpdate",
			      },
			      "template": {
			        "metadata": {
			          "annotations": {
			            "ever-works.io/revision": "rev-abc1234",
			          },
			          "labels": {
			            "app.kubernetes.io/managed-by": "ever-works-k8s-plugin",
			            "app.kubernetes.io/name": "work-1",
			            "ever-works.io/managed": "true",
			            "ever-works.io/work-id": "work-1",
			          },
			        },
			        "spec": {
			          "containers": [
			            {
			              "image": "ghcr.io/acme/work-1:abc1234",
			              "imagePullPolicy": "Always",
			              "livenessProbe": {
			                "failureThreshold": 6,
			                "httpGet": {
			                  "path": "/api/health",
			                  "port": "http",
			                },
			                "periodSeconds": 20,
			                "timeoutSeconds": 10,
			              },
			              "name": "app",
			              "ports": [
			                {
			                  "containerPort": 3000,
			                  "name": "http",
			                },
			              ],
			              "readinessProbe": {
			                "failureThreshold": 3,
			                "httpGet": {
			                  "path": "/api/health",
			                  "port": "http",
			                },
			                "periodSeconds": 10,
			                "timeoutSeconds": 5,
			              },
			              "resources": {
			                "limits": {
			                  "cpu": "2",
			                  "memory": "2Gi",
			                },
			                "requests": {
			                  "cpu": "100m",
			                  "memory": "256Mi",
			                },
			              },
			              "startupProbe": {
			                "failureThreshold": 30,
			                "httpGet": {
			                  "path": "/",
			                  "port": "http",
			                },
			                "periodSeconds": 10,
			                "timeoutSeconds": 10,
			              },
			            },
			          ],
			          "topologySpreadConstraints": [
			            {
			              "labelSelector": {
			                "matchLabels": {
			                  "app.kubernetes.io/name": "work-1",
			                },
			              },
			              "maxSkew": 1,
			              "topologyKey": "kubernetes.io/hostname",
			              "whenUnsatisfiable": "ScheduleAnyway",
			            },
			          ],
			        },
			      },
			    },
			  },
			  "ingress": {
			    "apiVersion": "networking.k8s.io/v1",
			    "kind": "Ingress",
			    "metadata": {
			      "annotations": {
			        "cert-manager.io/cluster-issuer": "letsencrypt-prod",
			        "nginx.ingress.kubernetes.io/proxy-body-size": "10m",
			        "nginx.ingress.kubernetes.io/ssl-redirect": "true",
			      },
			      "labels": {
			        "app.kubernetes.io/managed-by": "ever-works-k8s-plugin",
			        "app.kubernetes.io/name": "work-1",
			        "ever-works.io/managed": "true",
			        "ever-works.io/work-id": "work-1",
			      },
			      "name": "work-1",
			      "namespace": "ever-works",
			    },
			    "spec": {
			      "ingressClassName": "nginx",
			      "rules": [
			        {
			          "host": "work-1.example.com",
			          "http": {
			            "paths": [
			              {
			                "backend": {
			                  "service": {
			                    "name": "work-1",
			                    "port": {
			                      "number": 80,
			                    },
			                  },
			                },
			                "path": "/",
			                "pathType": "Prefix",
			              },
			            ],
			          },
			        },
			      ],
			      "tls": [
			        {
			          "hosts": [
			            "work-1.example.com",
			          ],
			          "secretName": "work-1-example-com-tls",
			        },
			      ],
			    },
			  },
			  "service": {
			    "apiVersion": "v1",
			    "kind": "Service",
			    "metadata": {
			      "labels": {
			        "app.kubernetes.io/managed-by": "ever-works-k8s-plugin",
			        "app.kubernetes.io/name": "work-1",
			        "ever-works.io/managed": "true",
			        "ever-works.io/work-id": "work-1",
			      },
			      "name": "work-1",
			      "namespace": "ever-works",
			    },
			    "spec": {
			      "ports": [
			        {
			          "name": "http",
			          "port": 80,
			          "protocol": "TCP",
			          "targetPort": 3000,
			        },
			      ],
			      "selector": {
			        "app.kubernetes.io/name": "work-1",
			      },
			      "type": "ClusterIP",
			    },
			  },
			}
		`);
	});
});
