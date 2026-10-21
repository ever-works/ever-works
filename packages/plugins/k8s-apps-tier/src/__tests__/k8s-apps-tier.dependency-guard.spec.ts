import { vi } from 'vitest';
import type { AppDependencyContext } from '@ever-works/plugin';
import { SMTP_PROVIDER_ID } from '@ever-works/k8s-plugin';
import { KubernetesAppsTierPlugin } from '../index.js';

/**
 * Lane works-security — the `k8s` plugin now runs §6.1 over a member's `your-cluster` kubeconfig on the
 * dependency path (`EVER_WORKS_APPS_GUARD_DEPENDENCY_KUBECONFIG`, default on). The managed tier inherits those
 * members; these cases pin that its OPERATOR-held `ever-works-apps` credential — a platform cluster that is
 * legitimately internal — still reaches the providers exactly as before, while a `your-cluster` context that
 * somehow reached this plugin is still guarded in full.
 */

/** The platform cluster: a private address, which the member-path pin would refuse. */
const OPERATOR_KUBECONFIG = [
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

function context(target: 'ever-works-apps' | 'your-cluster'): AppDependencyContext {
	return {
		workId: 'w1',
		appName: 'timetrack',
		target,
		declared: {},
		cluster: { kubeconfig: OPERATOR_KUBECONFIG, context: null, namespace: 'ewapp-0123abcd', appLabels: {} },
		settings: {},
		signal: new AbortController().signal
	} as unknown as AppDependencyContext;
}

/** An API service that fails on any call — nothing in these cases may reach a client. */
function noClientApi(): unknown {
	return new Proxy(
		{},
		{
			get(_target, prop) {
				if (typeof prop === 'symbol' || prop === 'then') return undefined;
				return () => {
					throw new Error(`api.${String(prop)} must not be called`);
				};
			}
		}
	);
}

function tierWithSpiedSmtp() {
	const tier = new KubernetesAppsTierPlugin({ api: noClientApi() as never, env: {} });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const smtp = (tier as any).smtpDependencies;
	const seen: AppDependencyContext[] = [];
	vi.spyOn(smtp, 'provision').mockImplementation(async (_id: unknown, ctx: unknown) => {
		seen.push(ctx as AppDependencyContext);
		return { state: 'ready', outputs: {}, resourceRefs: { objects: [] } };
	});
	vi.spyOn(smtp, 'getOutputs').mockImplementation(async (_id: unknown, ctx: unknown) => {
		seen.push(ctx as AppDependencyContext);
		return {};
	});
	vi.spyOn(smtp, 'deprovision').mockImplementation(async (_id: unknown, ctx: unknown) => {
		seen.push(ctx as AppDependencyContext);
		return { state: 'deleted' };
	});
	vi.spyOn(smtp, 'backupStatus').mockImplementation(async (_id: unknown, ctx: unknown) => {
		seen.push(ctx as AppDependencyContext);
		return { state: 'none' };
	});
	return { tier, seen };
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe('KubernetesAppsTierPlugin — dependency path under the k8s plugin guard', () => {
	it('hands the operator credential to the provider unchanged on all four members, guard on', async () => {
		vi.stubEnv('EVER_WORKS_APPS_GUARD_DEPENDENCY_KUBECONFIG', undefined);
		const { tier, seen } = tierWithSpiedSmtp();
		const ctx = context('ever-works-apps');

		await expect(tier.provision(SMTP_PROVIDER_ID, ctx)).resolves.toMatchObject({ state: 'ready' });
		await expect(tier.getOutputs(SMTP_PROVIDER_ID, ctx)).resolves.toEqual({});
		await expect(tier.deprovision(SMTP_PROVIDER_ID, ctx, { deleteData: true })).resolves.toEqual({
			state: 'deleted'
		});
		await expect(tier.backupStatus(SMTP_PROVIDER_ID, ctx)).resolves.toEqual({ state: 'none' });

		expect(seen).toHaveLength(4);
		for (const received of seen) expect(received).toBe(ctx);
	});

	it('still guards a your-cluster context in full (the private address is refused, no provider runs)', async () => {
		vi.stubEnv('EVER_WORKS_APPS_GUARD_DEPENDENCY_KUBECONFIG', undefined);
		const { tier, seen } = tierWithSpiedSmtp();

		await expect(tier.provision(SMTP_PROVIDER_ID, context('your-cluster'))).resolves.toMatchObject({
			state: 'failed',
			detail: { code: 'CLUSTER_ADDRESS_NOT_PUBLIC' }
		});
		expect(seen).toEqual([]);
	});
});
