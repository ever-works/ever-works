import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginContext } from '@ever-works/plugin';
import { KubernetesPlugin } from '../k8s.plugin';
import { KubernetesApiService } from '../k8s-api.service';
import type {
	IngressClassDescriptor,
	KubernetesClusterInfo,
} from '../types';

const VALID = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-valid.yml'), 'utf-8');

function createMockContext(settings: Record<string, unknown> = {}): PluginContext {
	return {
		pluginId: 'k8s',
		logger: { log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
		cache: {
			get: vi.fn(),
			set: vi.fn(),
			delete: vi.fn(),
			clear: vi.fn(),
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
		getCustomCapability: vi.fn(),
	} as unknown as PluginContext;
}

function makeMockApi(overrides: Partial<KubernetesApiService> = {}): KubernetesApiService {
	const stub = {
		validateConnection: vi.fn(async (_yaml: string, opts: { hasStrategyFor: (c: string) => boolean }) => ({
			clusterName: 'kind-dev',
			serverUrl: 'https://kind.example.com:6443',
			serverVersion: 'v1.30.4',
			serverFingerprint: 'abc123def4567890',
			ingressClasses: [
				{
					name: 'nginx',
					controller: 'k8s.io/ingress-nginx',
					isDefault: true,
					hasStrategy: opts.hasStrategyFor('k8s.io/ingress-nginx'),
				},
			] as IngressClassDescriptor[],
			requiresExecPlugin: false,
		} satisfies KubernetesClusterInfo)),
		listIngressClasses: vi.fn(async () => [
			{
				name: 'nginx',
				controller: 'k8s.io/ingress-nginx',
				isDefault: true,
				hasStrategy: true,
			},
		]),
		getDeployment: vi.fn(async () => ({
			metadata: { name: 'my-site', namespace: 'ever-works' },
			status: { conditions: [{ type: 'Available', status: 'True' }] },
		})),
		listManagedDeployments: vi.fn(async () => []),
		applyDeployment: vi.fn(async () => undefined),
		applyService: vi.fn(async () => undefined),
		applyIngress: vi.fn(async () => undefined),
		applyImagePullSecret: vi.fn(async () => undefined),
		readIngress: vi.fn(async () => ({
			metadata: { name: 'my-site' },
			spec: { ingressClassName: 'nginx', rules: [], tls: [] },
		})),
		getServerVersion: vi.fn(async () => 'v1.30.4'),
		...overrides,
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

	it('only requires kubeconfig (registry has a default)', () => {
		expect(plugin.settingsSchema.required).toEqual(['kubeconfig']);
	});

	it('registry sub-form is a oneOf with three branches (github default)', () => {
		const reg = plugin.settingsSchema.properties?.registry as { oneOf?: unknown[]; default?: { kind: string } };
		expect(reg.oneOf).toHaveLength(3);
		expect(reg.default?.kind).toBe('github');
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
			}),
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

	it('passes optional fields through when set', async () => {
		const out = await plugin.getDeploymentSecrets({
			namespace: 'apps',
			ingressClass: 'nginx',
			ingressHost: 'a.example.com',
			tlsIssuer: 'letsencrypt-prod',
			replicas: 3,
		});
		expect(out.K8S_NAMESPACE).toBe('apps');
		expect(out.K8S_INGRESS_CLASS).toBe('nginx');
		expect(out.K8S_INGRESS_HOST).toBe('a.example.com');
		expect(out.K8S_TLS_ISSUER).toBe('letsencrypt-prod');
		expect(out.K8S_REPLICAS).toBe('3');
	});

	it('emits github-specific vars without leaking auth (no GITHUB_TOKEN here)', async () => {
		const out = await plugin.getDeploymentSecrets({ registry: { kind: 'github', owner: 'acme', visibility: 'auto' } });
		expect(out.K8S_REGISTRY_KIND).toBe('github');
		expect(out.K8S_REGISTRY_OWNER).toBe('acme');
		expect(out.K8S_REGISTRY_VISIBILITY).toBe('auto');
		expect(out.GITHUB_TOKEN).toBeUndefined();
		expect(out.REGISTRY_PASSWORD).toBeUndefined();
	});

	it('emits dockerhub username + password as REGISTRY_USERNAME / REGISTRY_PASSWORD', async () => {
		const out = await plugin.getDeploymentSecrets({
			registry: { kind: 'dockerhub', username: 'acme', password: 'mYr3gistryPwD!' },
		});
		expect(out.REGISTRY_USERNAME).toBe('acme');
		expect(out.REGISTRY_PASSWORD).toBe('mYr3gistryPwD!');
	});

	it('emits generic REGISTRY_SERVER alongside username/password', async () => {
		const out = await plugin.getDeploymentSecrets({
			registry: { kind: 'generic', server: 'registry.example.com', username: 'acme', password: 'p' },
		});
		expect(out.REGISTRY_SERVER).toBe('registry.example.com');
		expect(out.REGISTRY_USERNAME).toBe('acme');
		expect(out.REGISTRY_PASSWORD).toBe('p');
	});

	it('does NOT leak the kubeconfig in any returned value', async () => {
		const out = await plugin.getDeploymentSecrets({
			kubeconfig: VALID,
			registry: { kind: 'github' },
		});
		for (const v of Object.values(out)) {
			expect(v).not.toContain('apiVersion: v1');
			expect(v).not.toContain('kind: Config');
		}
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
		registry: { kind: 'github', visibility: 'auto' },
	});

	beforeEach(async () => {
		api = makeMockApi();
		plugin = new KubernetesPlugin({ api });
		await plugin.onLoad(ctx);
	});

	it('public website repo → no pull secret applied', async () => {
		const result = await plugin.deploy(
			{ projectName: 'work-1', sourceDir: '.', options: { gitSha: 'abc1234', githubOwner: 'acme', websiteRepoIsPrivate: false } },
			VALID,
		);
		expect(result.status).toBe('deploying');
		expect(api.applyImagePullSecret).not.toHaveBeenCalled();
		expect(api.applyDeployment).toHaveBeenCalledTimes(1);
		expect(api.applyService).toHaveBeenCalledTimes(1);
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
					githubReadPackagesToken: 'ghp_fake',
				},
			},
			VALID,
		);
		expect(result.status).toBe('deploying');
		expect(api.applyImagePullSecret).toHaveBeenCalledTimes(1);
	});

	it('private GHCR without a read:packages token → status: error (scrubbed)', async () => {
		const result = await plugin.deploy(
			{
				projectName: 'work-1',
				sourceDir: '.',
				options: { gitSha: 'abc1234', githubOwner: 'acme', websiteRepoIsPrivate: true },
			},
			VALID,
		);
		expect(result.status).toBe('error');
		expect(result.error).toMatch(/read:packages/i);
		expect(api.applyDeployment).not.toHaveBeenCalled();
	});

	it('apply failures end up as status: error with scrubbed message', async () => {
		const failing = makeMockApi({
			applyDeployment: vi.fn(async () => {
				throw new Error('403 Forbidden — token: leak-12345');
			}),
		});
		const p = new KubernetesPlugin({ api: failing });
		await p.onLoad(ctx);
		const result = await p.deploy(
			{ projectName: 'work-1', sourceDir: '.', options: { githubOwner: 'acme', websiteRepoIsPrivate: false } },
			VALID,
		);
		expect(result.status).toBe('error');
		expect(result.error).not.toContain('leak-12345');
	});
});

describe('KubernetesPlugin.getDeploymentStatus', () => {
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

describe('KubernetesPlugin.getTeams', () => {
	it('returns an empty list (k8s has no team concept)', async () => {
		expect(await new KubernetesPlugin().getTeams('whatever')).toEqual([]);
	});
});
