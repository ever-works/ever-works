import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginContext } from '@ever-works/plugin';
import { KubernetesPlugin } from '../k8s.plugin';
import { KubernetesApiService } from '../k8s-api.service';
import { buildDeployment, buildRuntimeEnvSecret } from '../manifest.renderer';

const VALID = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-valid.yml'), 'utf-8');

/**
 * Server-side (platform-managed) deploy support — EW: the platform applies
 * manifests directly instead of dispatching a GitHub Actions workflow, so
 * three new inputs flow through `KubernetesPlugin.deploy()`:
 *
 *  - `namespaceOverride` — the namespace the platform ENFORCED server-side,
 *    which must beat the plugin's own persisted settings;
 *  - `imageName` — the website-repo name CI actually pushed the image under,
 *    which is not always the work slug (legacy works);
 *  - `runtimeEnv` — the runtime environment, applied as the
 *    `<slug>-runtime-env` Secret and `envFrom`'d into the container.
 */

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

function makeMockApi(): KubernetesApiService {
	return {
		listIngressClasses: vi.fn(async () => [
			{
				name: 'nginx',
				controller: 'k8s.io/ingress-nginx',
				isDefault: true,
				hasStrategy: true
			}
		]),
		applyDeployment: vi.fn(async () => undefined),
		applyService: vi.fn(async () => undefined),
		applyIngress: vi.fn(async () => undefined),
		applyImagePullSecret: vi.fn(async () => undefined),
		applySecret: vi.fn(async () => undefined),
		ensureNamespace: vi.fn(async () => undefined)
	} as unknown as KubernetesApiService;
}

describe('manifest.renderer — server-side inputs', () => {
	const base = {
		workId: 'work-1',
		workSlug: 'my-site',
		namespace: 'ns-1',
		image: 'ghcr.io/acme/site:abc',
		replicas: 1,
		containerPort: 3000,
		hosts: []
	};

	it('mounts the runtime-env Secret via optional envFrom when named', () => {
		const manifest = buildDeployment({ ...base, envFromSecretName: 'my-site-runtime-env' });
		const container = (manifest as any).spec.template.spec.containers[0];
		expect(container.envFrom).toEqual([
			{ secretRef: { name: 'my-site-runtime-env', optional: true } }
		]);
	});

	it('adds no envFrom when no secret is named (pre-existing behaviour)', () => {
		const manifest = buildDeployment(base);
		const container = (manifest as any).spec.template.spec.containers[0];
		expect(container.envFrom).toBeUndefined();
	});

	it('builds the runtime-env Secret with stringData and managed labels', () => {
		const secret = buildRuntimeEnvSecret({
			name: 'my-site-runtime-env',
			namespace: 'ns-1',
			workId: 'work-1',
			workSlug: 'my-site',
			env: { AUTH_SECRET: 's3cret', SITE_URL: 'https://my-site.ever.works' }
		}) as any;
		expect(secret.kind).toBe('Secret');
		expect(secret.type).toBe('Opaque');
		expect(secret.metadata.namespace).toBe('ns-1');
		expect(secret.stringData).toEqual({
			AUTH_SECRET: 's3cret',
			SITE_URL: 'https://my-site.ever.works'
		});
		expect(secret.metadata.labels['ever-works.io/managed']).toBe('true');
		expect(secret.metadata.labels['ever-works.io/work-id']).toBe('work-1');
	});
});

describe('KubernetesPlugin.deploy — server-side inputs (mocked api)', () => {
	let plugin: KubernetesPlugin;
	let api: KubernetesApiService;
	const ctx = createMockContext({
		kubeconfig: VALID,
		namespace: 'settings-namespace',
		registry: { kind: 'github', visibility: 'auto' }
	});

	beforeEach(async () => {
		api = makeMockApi();
		plugin = new KubernetesPlugin({ api });
		await plugin.onLoad(ctx);
	});

	it('namespaceOverride beats the plugin-settings namespace', async () => {
		const result = await plugin.deploy(
			{
				projectName: 'my-site',
				sourceDir: '.',
				options: {
					gitSha: 'abc123def456',
					githubOwner: 'acme',
					websiteRepoIsPrivate: false,
					namespaceOverride: 'enforced-ns'
				}
			},
			VALID
		);
		expect(result.status).toBe('deploying');
		expect(api.ensureNamespace).toHaveBeenCalledWith(VALID, 'enforced-ns', undefined);
		const deployment = (api.applyDeployment as any).mock.calls[0][1];
		expect(deployment.metadata.namespace).toBe('enforced-ns');
	});

	it('imageName pins the image repo while manifests keep the slug', async () => {
		await plugin.deploy(
			{
				projectName: 'mcpserver',
				sourceDir: '.',
				options: {
					gitSha: 'abc123def456',
					githubOwner: 'ever-works',
					websiteRepoIsPrivate: false,
					imageName: 'awesome-mcp-servers-website'
				}
			},
			VALID
		);
		const deployment = (api.applyDeployment as any).mock.calls[0][1];
		expect(deployment.metadata.name).toBe('mcpserver');
		expect(deployment.spec.template.spec.containers[0].image).toBe(
			'ghcr.io/ever-works/awesome-mcp-servers-website:abc123def456'
		);
	});

	it('runtimeEnv applies the Secret BEFORE the Deployment and wires envFrom', async () => {
		const order: string[] = [];
		(api.applySecret as any).mockImplementation(async () => {
			order.push('secret');
		});
		(api.applyDeployment as any).mockImplementation(async () => {
			order.push('deployment');
		});

		await plugin.deploy(
			{
				projectName: 'my-site',
				sourceDir: '.',
				options: {
					gitSha: 'abc123def456',
					githubOwner: 'acme',
					websiteRepoIsPrivate: false,
					runtimeEnv: { AUTH_SECRET: 's3cret' }
				}
			},
			VALID
		);

		expect(order).toEqual(['secret', 'deployment']);
		const secret = (api.applySecret as any).mock.calls[0][1];
		expect(secret.metadata.name).toBe('my-site-runtime-env');
		expect(secret.stringData).toEqual({ AUTH_SECRET: 's3cret' });
		const deployment = (api.applyDeployment as any).mock.calls[0][1];
		expect(deployment.spec.template.spec.containers[0].envFrom).toEqual([
			{ secretRef: { name: 'my-site-runtime-env', optional: true } }
		]);
	});

	it('no runtimeEnv → no Secret applied, no envFrom (pre-existing behaviour)', async () => {
		await plugin.deploy(
			{
				projectName: 'my-site',
				sourceDir: '.',
				options: {
					gitSha: 'abc123def456',
					githubOwner: 'acme',
					websiteRepoIsPrivate: false
				}
			},
			VALID
		);
		expect(api.applySecret).not.toHaveBeenCalled();
		const deployment = (api.applyDeployment as any).mock.calls[0][1];
		expect(deployment.spec.template.spec.containers[0].envFrom).toBeUndefined();
	});
});
