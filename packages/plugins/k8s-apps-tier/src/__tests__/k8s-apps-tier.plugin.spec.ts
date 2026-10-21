import { KubernetesPlugin } from '@ever-works/k8s-plugin';
import { KubernetesAppsTierPlugin } from '../index.js';
import { managedNamespaceGrant } from '../k8s-apps-tier.plugin.js';

/** APW-10 lite — the managed target's plugin, and the two-way target split with `k8s`. */

const KUBECONFIG = [
	'apiVersion: v1',
	'kind: Config',
	'current-context: ew',
	'clusters:',
	'  - name: ew',
	'    cluster:',
	'      server: https://192.168.1.150:6443',
	'      certificate-authority-data: Y2E=',
	'contexts:',
	'  - name: ew',
	'    context: { cluster: ew, user: ew }',
	'users:',
	'  - name: ew',
	'    user: { token: abc }',
	''
].join('\n');

const managedRef = { workId: 'w1', namespace: 'ewapp-0123abcd', target: 'ever-works-apps' as const, kubeContext: null };
const clusterRef = { workId: 'w1', namespace: 'ew-app-0123abcd', target: 'your-cluster' as const, kubeContext: null };

describe('KubernetesAppsTierPlugin', () => {
	it('declares deployment + apps-tier + app-dependency under its own id, hidden', () => {
		const plugin = new KubernetesAppsTierPlugin();
		expect(plugin.id).toBe('k8s-apps-tier');
		expect([...plugin.capabilities]).toEqual(['deployment', 'apps-tier', 'app-dependency']);
		const manifest = plugin.getManifest();
		expect(manifest.id).toBe('k8s-apps-tier');
		expect(manifest.capabilities).toEqual(['deployment', 'apps-tier', 'app-dependency']);
		expect(manifest.visibility).toBe('hidden');
		expect(plugin.supportsApps).toBe(true);
	});

	it('serves ever-works-apps only; the k8s plugin serves your-cluster only', async () => {
		const tier = new KubernetesAppsTierPlugin() as unknown as {
			assertThisPluginServes(ref: unknown): void;
		};
		const k8s = new KubernetesPlugin() as unknown as { assertThisPluginServes(ref: unknown): void };
		expect(() => tier.assertThisPluginServes(managedRef)).not.toThrow();
		expect(() => tier.assertThisPluginServes(clusterRef)).toThrow(/does not serve/);
		expect(() => k8s.assertThisPluginServes(clusterRef)).not.toThrow();
		expect(() => k8s.assertThisPluginServes(managedRef)).toThrow(/does not serve/);
	});

	it('accepts the operator kubeconfig on a private address (shape checks only)', async () => {
		const tier = new KubernetesAppsTierPlugin() as unknown as {
			guardedAppCredential(credential: string, ctx?: string | null): Promise<string>;
		};
		await expect(tier.guardedAppCredential(KUBECONFIG)).resolves.toBe(KUBECONFIG);
		await expect(
			tier.guardedAppCredential(
				KUBECONFIG.replace('    user: { token: abc }', '    user: { exec: { command: sh } }')
			)
		).rejects.toThrow();
	});

	it('refuses website deploys', async () => {
		await expect(new KubernetesAppsTierPlugin().deploy({} as never, KUBECONFIG)).rejects.toThrow(/App Works only/);
	});
});

describe('the per-namespace grant (least privilege)', () => {
	it('applies the Namespace and the RoleBinding before deploying, and only into ewapp-*', async () => {
		const applied: Array<Record<string, unknown>> = [];
		const api = {
			applyObject: vi.fn(async (_c: string, manifest: Record<string, unknown>) => void applied.push(manifest))
		};
		const plugin = new KubernetesAppsTierPlugin({ api: api as never, env: {} });
		const deployer = vi
			.spyOn(KubernetesPlugin.prototype, 'deployApp')
			.mockResolvedValue({ outcome: 'succeeded' } as never);
		await plugin.deployApp(
			{ ref: managedRef, workSlug: 'helpdesk', policy: { podSecurity: 'restricted' } } as never,
			KUBECONFIG,
			{} as never
		);
		expect(applied.map((o) => o.kind)).toEqual(['Namespace', 'RoleBinding']);
		expect((applied[0].metadata as { name: string }).name).toBe('ewapp-0123abcd');
		expect(applied[1]).toMatchObject({
			metadata: { name: 'ever-works-apps-controller', namespace: 'ewapp-0123abcd' },
			roleRef: { kind: 'ClusterRole', name: 'ever-works-apps-namespace-admin' },
			subjects: [
				{ kind: 'ServiceAccount', name: 'ever-works-apps-controller', namespace: 'ever-works-apps-system' }
			]
		});
		expect(deployer).toHaveBeenCalled();

		await expect(
			plugin.deployApp({ ref: { ...managedRef, namespace: 'kube-system' } } as never, KUBECONFIG, {} as never)
		).rejects.toThrow(/must start with 'ewapp-'/);
		deployer.mockRestore();
	});

	it('honours the service-account and role overrides', () => {
		expect(
			managedNamespaceGrant('ewapp-1', {
				EVER_WORKS_APPS_MANAGED_SERVICE_ACCOUNT: 'ops/apps-bot',
				EVER_WORKS_APPS_MANAGED_NAMESPACE_ROLE: 'tenant-admin'
			})
		).toMatchObject({
			roleRef: { name: 'tenant-admin' },
			subjects: [{ name: 'apps-bot', namespace: 'ops' }]
		});
	});
});

describe('dependencies on the managed tier', () => {
	const ctx = { workId: 'w1', appName: 'app', target: 'ever-works-apps', declared: {}, settings: {} } as never;

	it('publishes the in-cluster providers for ever-works-apps only', () => {
		const plugin = new KubernetesAppsTierPlugin();
		expect(plugin.capabilities).toContain('app-dependency');
		expect(plugin.getManifest().capabilities).toContain('app-dependency');
		const kinds = plugin.dependencyProviders.map((descriptor) => descriptor.kind).sort();
		expect(kinds).toEqual(['objectStorage', 'postgres', 'redis', 'smtp']);
		for (const descriptor of plugin.dependencyProviders) {
			expect(descriptor.targets).toEqual(['ever-works-apps']);
			expect(descriptor.label).toMatch(/^On Ever Works · /);
		}
		// The k8s plugin keeps them for your-cluster only, under the same provider ids.
		const k8s = new KubernetesPlugin();
		expect(k8s.dependencyProviders.every((descriptor) => descriptor.targets.join() === 'your-cluster')).toBe(true);
		expect(plugin.dependencyProviders.map((d) => d.id).sort()).toEqual(
			k8s.dependencyProviders.map((d) => d.id).sort()
		);
	});

	it('answers supports for ever-works-apps through the same providers, and refuses your-cluster', async () => {
		const plugin = new KubernetesAppsTierPlugin();
		await expect(plugin.supports('postgres', 'ever-works-apps', ctx)).resolves.toMatchObject({ supported: true });
		await expect(plugin.supports('redis', 'ever-works-apps', ctx)).resolves.toMatchObject({ supported: true });
		await expect(plugin.supports('objectStorage', 'ever-works-apps', ctx)).resolves.toMatchObject({
			supported: true
		});
		// Lane aw-env-smtp (GAP-22): the `smtp` mail sink is served on the managed tier too.
		await expect(plugin.supports('smtp', 'ever-works-apps', ctx)).resolves.toEqual({
			supported: true,
			providerId: 'k8s-inline-mailpit'
		});
		await expect(plugin.supports('postgres', 'your-cluster', ctx)).resolves.toMatchObject({ supported: false });
		await expect(new KubernetesPlugin().supports('postgres', 'ever-works-apps', ctx)).resolves.toMatchObject({
			supported: false
		});
	});
});
