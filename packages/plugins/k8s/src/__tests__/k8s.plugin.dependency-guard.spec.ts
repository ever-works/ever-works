/**
 * Lane works-security — §6.1 on the App DEPENDENCY path of the `k8s` plugin.
 *
 * `provision` / `getOutputs` / `deprovision` / `backupStatus` used to hand a member's `your-cluster`
 * kubeconfig to the providers verbatim, on the false premise that APW-06 had already pinned it. These cases
 * pin the fix: the shape refusals and the address pin run before any provider (and so any client) sees the
 * credential, the providers receive the PINNED YAML, the managed tier is untouched, and
 * `EVER_WORKS_APPS_GUARD_DEPENDENCY_KUBECONFIG=false` restores the pass-through exactly. Plus the pure
 * save-time check, `checkClusterCredentialShape`, whose message never echoes the kubeconfig.
 *
 * No case performs real DNS or network I/O: the resolver is injected (`clusterAddressResolver`), and the
 * API service is either a recorder that fails on any call or the in-memory dependency cluster fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';
import type { AppDependencyContext, AppDependencyProviderDescriptor, AppDependencyTarget } from '@ever-works/plugin';

import {
	DEPENDENCY_KUBECONFIG_GUARD_ENV,
	KubernetesPlugin,
	dependencyKubeconfigGuardEnabled,
	describeKubeconfigRefusal
} from '../k8s.plugin';
import type { KubernetesApiService } from '../k8s-api.service';
import { K8sPluginError } from '../errors';
import { CLUSTER_PRIVATE_ALLOWLIST_ENV, assertSupportedKubeconfig } from '../app/app-kubeconfig.guard';
import type { KubeconfigDnsResolver } from '../app/app-kubeconfig.guard';
import { POSTGRES_PROVIDER_ID, PostgresDependencyProvider } from '../app-dependencies/postgres.provider';
import { REDIS_PROVIDER_ID, RedisDependencyProvider } from '../app-dependencies/redis.provider';
import {
	OBJECT_STORAGE_PROVIDER_ID,
	ObjectStorageDependencyProvider
} from '../app-dependencies/object-storage.provider';
import { SMTP_PROVIDER_DESCRIPTOR, SMTP_PROVIDER_ID, SmtpDependencyProvider } from '../app-dependencies/smtp.provider';
import { FakeDependencyCluster } from '../app-dependencies/__tests__/dependency-cluster.fake';

const VALID = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-valid.yml'), 'utf-8');
const EXEC = readFileSync(resolve(__dirname, 'fixtures/kubeconfig-exec.yml'), 'utf-8');

type Mapping = Record<string, unknown>;

/** `VALID` with its one cluster / user body edited — the guard's refusal shapes, built from a real document. */
function edited(source: string, edit: (parts: { cluster: Mapping; user: Mapping; doc: Mapping }) => void): string {
	const doc = yaml.load(source) as {
		clusters: Array<{ cluster: Mapping }>;
		users: Array<{ user: Mapping }>;
	};
	edit({ cluster: doc.clusters[0].cluster, user: doc.users[0].user, doc: doc as unknown as Mapping });
	return yaml.dump(doc, { lineWidth: -1 });
}

const INSECURE = edited(VALID, ({ cluster }) => {
	cluster['insecure-skip-tls-verify'] = true;
});

const ALL_PROVIDER_IDS = [POSTGRES_PROVIDER_ID, REDIS_PROVIDER_ID, OBJECT_STORAGE_PROVIDER_ID, SMTP_PROVIDER_ID];

/** What `kind.example.com` (the VALID fixture's server host) resolves to in the case at hand. */
let clusterAddress = '93.184.216.34';
let resolverFails = false;
const resolver = vi.fn<KubeconfigDnsResolver>(async (hostname) => {
	if (resolverFails) throw new Error('SERVFAIL');
	if (hostname !== 'kind.example.com') throw new Error(`no answer for '${hostname}'`);
	return [{ address: clusterAddress, family: 4 }];
});

/** An API service that records — and fails — every call: the guard must refuse before any client exists. */
function recordingApi(): { api: KubernetesApiService; calls: string[] } {
	const calls: string[] = [];
	const api = new Proxy(
		{},
		{
			get(_target, prop) {
				if (typeof prop === 'symbol' || prop === 'then') return undefined;
				return (..._args: unknown[]) => {
					calls.push(prop);
					throw new Error(`api.${prop} must not be called`);
				};
			}
		}
	);
	return { api: api as unknown as KubernetesApiService, calls };
}

function context(kubeconfig: string, overrides: Partial<Mapping> = {}): AppDependencyContext {
	return {
		workId: 'work_1',
		appName: 'timetrack',
		target: 'your-cluster',
		declared: { version: 16 },
		cluster: {
			kubeconfig,
			context: 'kind-dev',
			namespace: 'ew-timetrack-1a2b3c4d',
			appLabels: { 'app.kubernetes.io/part-of': 'timetrack' }
		},
		settings: {},
		signal: new AbortController().signal,
		...overrides
	} as unknown as AppDependencyContext;
}

interface ProviderCall {
	method: 'provision' | 'getOutputs' | 'deprovision' | 'backupStatus';
	providerId: string;
	ctx: AppDependencyContext;
}

/** Every provider's four members, replaced by recorders — so a case asserts exactly what reached a provider. */
function spyOnProviders(): ProviderCall[] {
	const calls: ProviderCall[] = [];
	const prototypes = [
		PostgresDependencyProvider.prototype,
		RedisDependencyProvider.prototype,
		ObjectStorageDependencyProvider.prototype,
		SmtpDependencyProvider.prototype
	];
	for (const proto of prototypes) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const target = proto as any;
		vi.spyOn(target, 'provision').mockImplementation(async (providerId: unknown, ctx: unknown) => {
			calls.push({ method: 'provision', providerId: String(providerId), ctx: ctx as AppDependencyContext });
			return { state: 'ready', outputs: { host: 'h' }, resourceRefs: { objects: [] } };
		});
		vi.spyOn(target, 'getOutputs').mockImplementation(async (providerId: unknown, ctx: unknown) => {
			calls.push({ method: 'getOutputs', providerId: String(providerId), ctx: ctx as AppDependencyContext });
			return { host: 'h' };
		});
		vi.spyOn(target, 'deprovision').mockImplementation(async (providerId: unknown, ctx: unknown) => {
			calls.push({ method: 'deprovision', providerId: String(providerId), ctx: ctx as AppDependencyContext });
			return { state: 'deleted' };
		});
		vi.spyOn(target, 'backupStatus').mockImplementation(async (providerId: unknown, ctx: unknown) => {
			calls.push({ method: 'backupStatus', providerId: String(providerId), ctx: ctx as AppDependencyContext });
			return { state: 'none' };
		});
	}
	return calls;
}

function pluginWith(api?: KubernetesApiService): KubernetesPlugin {
	return new KubernetesPlugin({ api: api ?? recordingApi().api, clusterAddressResolver: resolver });
}

/** The server / tls-server-name a pinned kubeconfig names for its selected cluster. */
function serverOf(kubeconfig: string): { server: unknown; tlsServerName: unknown } {
	const doc = yaml.load(kubeconfig) as { clusters: Array<{ cluster: Mapping }> };
	const cluster = doc.clusters[0].cluster;
	return { server: cluster.server, tlsServerName: cluster['tls-server-name'] };
}

beforeEach(() => {
	clusterAddress = '93.184.216.34';
	resolverFails = false;
	resolver.mockClear();
	vi.stubEnv(DEPENDENCY_KUBECONFIG_GUARD_ENV, undefined);
	vi.stubEnv(CLUSTER_PRIVATE_ALLOWLIST_ENV, undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe('the switch — EVER_WORKS_APPS_GUARD_DEPENDENCY_KUBECONFIG', () => {
	it('is on unless the value is exactly false', () => {
		expect(DEPENDENCY_KUBECONFIG_GUARD_ENV).toBe('EVER_WORKS_APPS_GUARD_DEPENDENCY_KUBECONFIG');
		expect(dependencyKubeconfigGuardEnabled({})).toBe(true);
		expect(dependencyKubeconfigGuardEnabled({ [DEPENDENCY_KUBECONFIG_GUARD_ENV]: '' })).toBe(true);
		expect(dependencyKubeconfigGuardEnabled({ [DEPENDENCY_KUBECONFIG_GUARD_ENV]: 'true' })).toBe(true);
		expect(dependencyKubeconfigGuardEnabled({ [DEPENDENCY_KUBECONFIG_GUARD_ENV]: 'FALSE' })).toBe(true);
		expect(dependencyKubeconfigGuardEnabled({ [DEPENDENCY_KUBECONFIG_GUARD_ENV]: ' false' })).toBe(true);
		expect(dependencyKubeconfigGuardEnabled({ [DEPENDENCY_KUBECONFIG_GUARD_ENV]: '0' })).toBe(true);
		expect(dependencyKubeconfigGuardEnabled({ [DEPENDENCY_KUBECONFIG_GUARD_ENV]: 'false' })).toBe(false);
	});
});

describe('dependency path — the shape refusals (guard on by default)', () => {
	it('refuses an exec-plugin kubeconfig on provision, getOutputs, deprovision and backupStatus — no provider, no client, no DNS', async () => {
		const calls = spyOnProviders();
		const { api, calls: apiCalls } = recordingApi();
		const plugin = pluginWith(api);

		for (const providerId of ALL_PROVIDER_IDS) {
			const ctx = context(EXEC, { cluster: { ...context(EXEC).cluster!, context: null } });

			await expect(plugin.provision(providerId, ctx), providerId).resolves.toEqual({
				state: 'failed',
				reason: 'targetNotChecked',
				transient: false,
				detail: { code: 'KUBECONFIG_UNSUPPORTED' }
			});
			await expect(plugin.getOutputs(providerId, ctx), providerId).rejects.toMatchObject({
				code: 'KUBECONFIG_UNSUPPORTED'
			});
			await expect(plugin.deprovision(providerId, ctx, { deleteData: true }), providerId).rejects.toMatchObject({
				code: 'KUBECONFIG_UNSUPPORTED'
			});
			await expect(
				plugin.deprovision(providerId, ctx, { deleteData: false, stopWorkloads: true }),
				providerId
			).rejects.toMatchObject({ code: 'KUBECONFIG_UNSUPPORTED' });
			await expect(plugin.backupStatus(providerId, ctx), providerId).rejects.toMatchObject({
				code: 'KUBECONFIG_UNSUPPORTED'
			});
		}

		expect(calls).toEqual([]);
		expect(apiCalls).toEqual([]);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('answers a plain release (deleteData false, no stopWorkloads) as released without handing the refused credential to a provider', async () => {
		const calls = spyOnProviders();
		const plugin = pluginWith();

		for (const providerId of ALL_PROVIDER_IDS) {
			await expect(plugin.deprovision(providerId, context(EXEC), { deleteData: false })).resolves.toEqual({
				state: 'released'
			});
		}
		expect(calls).toEqual([]);
	});

	it('throws a refusal whose message never echoes the kubeconfig (no command, user, cluster or server)', async () => {
		spyOnProviders();
		const plugin = pluginWith();

		const error = await plugin.getOutputs(SMTP_PROVIDER_ID, context(EXEC)).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(K8sPluginError);
		const message = (error as Error).message;
		for (const fragment of ['aws-iam-authenticator', 'eks-user', 'eks-prod', 'EXAMPLE', 'amazonaws']) {
			expect(message).not.toContain(fragment);
		}
		expect(message).toMatch(/exec credential plugin/);
	});

	it('refuses insecure-skip-tls-verify before any DNS lookup', async () => {
		const calls = spyOnProviders();
		const plugin = pluginWith();

		await expect(plugin.provision(POSTGRES_PROVIDER_ID, context(INSECURE))).resolves.toMatchObject({
			state: 'failed',
			reason: 'targetNotChecked',
			transient: false,
			detail: { code: 'KUBECONFIG_UNSUPPORTED' }
		});
		await expect(plugin.getOutputs(POSTGRES_PROVIDER_ID, context(INSECURE))).rejects.toMatchObject({
			code: 'KUBECONFIG_UNSUPPORTED',
			message: expect.stringMatching(/insecure-skip-tls-verify/)
		});
		expect(calls).toEqual([]);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('refuses tokenFile, client certificate/key files, a CA file, proxy-url and a non-https server', async () => {
		const calls = spyOnProviders();
		const plugin = pluginWith();
		const variants = [
			edited(VALID, ({ user }) => {
				user.tokenFile = '/var/run/secrets/token';
			}),
			edited(VALID, ({ user }) => {
				user['client-certificate'] = '/etc/kube/client.crt';
			}),
			edited(VALID, ({ user }) => {
				user['client-key'] = '/etc/kube/client.key';
			}),
			edited(VALID, ({ cluster }) => {
				cluster['certificate-authority'] = '/etc/kube/ca.crt';
			}),
			edited(VALID, ({ cluster }) => {
				cluster['proxy-url'] = 'http://10.0.0.5:3128';
			}),
			edited(VALID, ({ cluster }) => {
				cluster.server = 'http://kind.example.com:6443';
			})
		];

		for (const kubeconfig of variants) {
			await expect(plugin.provision(REDIS_PROVIDER_ID, context(kubeconfig))).resolves.toMatchObject({
				state: 'failed',
				reason: 'targetNotChecked',
				detail: { code: 'KUBECONFIG_UNSUPPORTED' }
			});
		}
		expect(calls).toEqual([]);
		expect(resolver).not.toHaveBeenCalled();
	});
});

describe('dependency path — the address pin (FR-4)', () => {
	it('refuses a cluster host that resolves to a private address, on every member, before any provider runs', async () => {
		const calls = spyOnProviders();
		const plugin = pluginWith();

		for (const address of ['10.0.0.1', '169.254.169.254', '::ffff:10.0.0.1']) {
			clusterAddress = address;
			const ctx = context(VALID);

			await expect(plugin.provision(OBJECT_STORAGE_PROVIDER_ID, ctx), address).resolves.toEqual({
				state: 'failed',
				reason: 'targetNotChecked',
				transient: false,
				detail: { code: 'CLUSTER_ADDRESS_NOT_PUBLIC' }
			});
			await expect(plugin.getOutputs(OBJECT_STORAGE_PROVIDER_ID, ctx), address).rejects.toMatchObject({
				code: 'CLUSTER_ADDRESS_NOT_PUBLIC'
			});
			await expect(
				plugin.deprovision(OBJECT_STORAGE_PROVIDER_ID, ctx, { deleteData: true }),
				address
			).rejects.toMatchObject({ code: 'CLUSTER_ADDRESS_NOT_PUBLIC' });
			await expect(plugin.backupStatus(OBJECT_STORAGE_PROVIDER_ID, ctx), address).rejects.toMatchObject({
				code: 'CLUSTER_ADDRESS_NOT_PUBLIC'
			});
		}

		expect(calls).toEqual([]);
		expect(resolver).toHaveBeenCalledWith('kind.example.com');
	});

	it('refuses a private IP literal server without a lookup', async () => {
		const calls = spyOnProviders();
		const plugin = pluginWith();
		const literal = edited(VALID, ({ cluster }) => {
			cluster.server = 'https://10.96.0.1:443';
		});

		await expect(plugin.provision(SMTP_PROVIDER_ID, context(literal))).resolves.toMatchObject({
			reason: 'targetNotChecked',
			detail: { code: 'CLUSTER_ADDRESS_NOT_PUBLIC' }
		});
		expect(calls).toEqual([]);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('reads a failed lookup as a transient unreachable cluster, not as a policy refusal', async () => {
		const calls = spyOnProviders();
		resolverFails = true;

		await expect(pluginWith().provision(POSTGRES_PROVIDER_ID, context(VALID))).resolves.toEqual({
			state: 'failed',
			reason: 'clusterUnreachable',
			transient: true,
			detail: { code: 'CLUSTER_UNREACHABLE' }
		});
		expect(calls).toEqual([]);
	});

	it('honours the operator allow-list exactly as the App members do', async () => {
		const calls = spyOnProviders();
		vi.stubEnv(CLUSTER_PRIVATE_ALLOWLIST_ENV, '10.0.0.0/8');
		clusterAddress = '10.0.0.7';

		await expect(pluginWith().provision(POSTGRES_PROVIDER_ID, context(VALID))).resolves.toMatchObject({
			state: 'ready'
		});
		expect(calls).toHaveLength(1);
		expect(serverOf(calls[0].ctx.cluster!.kubeconfig)).toEqual({
			server: 'https://10.0.0.7:6443',
			tlsServerName: 'kind.example.com'
		});
	});
});

describe('dependency path — a supported kubeconfig', () => {
	it('still provisions, and every provider receives the PINNED kubeconfig on all four members', async () => {
		const calls = spyOnProviders();
		const plugin = pluginWith();

		for (const providerId of ALL_PROVIDER_IDS) {
			const ctx = context(VALID);
			const snapshot = JSON.stringify(ctx);

			await expect(plugin.provision(providerId, ctx)).resolves.toMatchObject({ state: 'ready' });
			await expect(plugin.getOutputs(providerId, ctx)).resolves.toEqual({ host: 'h' });
			await expect(plugin.deprovision(providerId, ctx, { deleteData: true })).resolves.toEqual({
				state: 'deleted'
			});
			await expect(plugin.backupStatus(providerId, ctx)).resolves.toEqual({ state: 'none' });

			// The caller's context is never mutated — the providers get a copy.
			expect(JSON.stringify(ctx)).toBe(snapshot);
		}

		expect(calls).toHaveLength(ALL_PROVIDER_IDS.length * 4);
		for (const call of calls) {
			const label = `${call.providerId}.${call.method}`;
			const cluster = call.ctx.cluster!;
			expect(cluster.kubeconfig, label).not.toBe(VALID);
			expect(serverOf(cluster.kubeconfig), label).toEqual({
				server: 'https://93.184.216.34:6443',
				tlsServerName: 'kind.example.com'
			});
			// Still a kubeconfig the guard accepts, for the same context.
			expect(() => assertSupportedKubeconfig(cluster.kubeconfig, 'kind-dev'), label).not.toThrow();
			// Everything else of the context is the caller's.
			expect(cluster.context, label).toBe('kind-dev');
			expect(cluster.namespace, label).toBe('ew-timetrack-1a2b3c4d');
			expect(cluster.appLabels, label).toEqual({ 'app.kubernetes.io/part-of': 'timetrack' });
			expect(call.ctx.workId, label).toBe('work_1');
			expect(call.ctx.declared, label).toEqual({ version: 16 });
		}
	});

	it('end to end over the dependency cluster fake: smtp provisions ready and every client call carries the pinned kubeconfig', async () => {
		const cluster = new FakeDependencyCluster();
		const seen: string[] = [];
		for (const method of ['applyObject', 'readObject', 'listObjects', 'deleteObject'] as const) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const original = (cluster as any)[method].bind(cluster);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(cluster as any)[method] = (kubeconfig: string, ...rest: unknown[]) => {
				seen.push(kubeconfig);
				return original(kubeconfig, ...rest);
			};
		}
		const plugin = pluginWith(cluster as unknown as KubernetesApiService);

		const outcome = await plugin.provision(SMTP_PROVIDER_ID, context(VALID));

		expect(outcome.state).toBe('ready');
		expect(cluster.appliedNames()).toContain('Deployment/dep-smtp');
		expect(seen.length).toBeGreaterThan(0);
		for (const kubeconfig of seen) {
			expect(kubeconfig).not.toBe(VALID);
			expect(serverOf(kubeconfig).server).toBe('https://93.184.216.34:6443');
		}
	});

	it('leaves a context without a credential to the providers (they answer "no cluster" themselves)', async () => {
		const calls = spyOnProviders();
		const ctx = context(VALID, { cluster: undefined });

		await pluginWith().provision(SMTP_PROVIDER_ID, ctx);

		expect(calls).toHaveLength(1);
		expect(calls[0].ctx).toBe(ctx);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('keeps an unserved provider id on its pre-guard answer', async () => {
		const calls = spyOnProviders();
		const plugin = pluginWith();

		await expect(plugin.provision('s3-external', context(EXEC))).resolves.toMatchObject({
			state: 'failed',
			reason: 'providerNotSupported'
		});
		await expect(plugin.deprovision('s3-external', context(EXEC), { deleteData: true })).resolves.toEqual({
			state: 'released'
		});
		await expect(plugin.backupStatus('s3-external', context(EXEC))).resolves.toEqual({ state: 'none' });
		expect(calls).toEqual([]);
	});
});

/**
 * The managed tier, modelled exactly as APW-10 lite's `KubernetesAppsTierPlugin` overrides the base class
 * (`packages/plugins/k8s-apps-tier/src/k8s-apps-tier.plugin.ts`): it serves `ever-works-apps` only, maps the
 * providers onto `your-cluster`, publishes them for `ever-works-apps`, and narrows `guardedAppCredential` to
 * the shape refusals. That package builds against this one's `dist`, so its class is mirrored here rather
 * than imported.
 */
class ManagedTierLikePlugin extends KubernetesPlugin {
	override readonly dependencyProviders: readonly AppDependencyProviderDescriptor[] = [
		{ ...SMTP_PROVIDER_DESCRIPTOR, targets: ['ever-works-apps'] }
	];

	protected override servesAppTarget(target: string | undefined): boolean {
		return target === 'ever-works-apps';
	}

	protected override dependencyProviderTarget(target: AppDependencyTarget): AppDependencyTarget {
		return target === 'ever-works-apps' ? 'your-cluster' : target;
	}

	protected override async guardedAppCredential(credential: string, kubeContext?: string | null): Promise<string> {
		assertSupportedKubeconfig(credential, kubeContext ?? undefined);
		return credential;
	}
}

describe('the managed tier (ever-works-apps) — unchanged', () => {
	it('hands the operator credential to the provider exactly as before: same context object, no guard, no pin, no DNS', async () => {
		const calls = spyOnProviders();
		const plugin = new ManagedTierLikePlugin({ api: recordingApi().api, clusterAddressResolver: resolver });
		clusterAddress = '10.0.0.1';

		// An internal platform cluster, and a shape the member path refuses — both pass through on this tier,
		// which is what the dependency path has always done for the operator-held credential.
		for (const kubeconfig of [VALID, EXEC]) {
			const ctx = context(kubeconfig, { target: 'ever-works-apps' });
			await plugin.provision(SMTP_PROVIDER_ID, ctx);
			await plugin.getOutputs(SMTP_PROVIDER_ID, ctx);
			await plugin.deprovision(SMTP_PROVIDER_ID, ctx, { deleteData: true });
			await plugin.backupStatus(SMTP_PROVIDER_ID, ctx);
			expect(calls.slice(-4).map((call) => call.ctx)).toEqual([ctx, ctx, ctx, ctx]);
			for (const call of calls.slice(-4)) expect(call.ctx).toBe(ctx);
		}
		expect(resolver).not.toHaveBeenCalled();
	});

	it('still runs the FULL guard for a your-cluster context on that plugin (its shape-only rule cannot narrow the dependency path)', async () => {
		const calls = spyOnProviders();
		const plugin = new ManagedTierLikePlugin({ api: recordingApi().api, clusterAddressResolver: resolver });
		clusterAddress = '10.0.0.1';

		await expect(plugin.provision(SMTP_PROVIDER_ID, context(VALID))).resolves.toMatchObject({
			detail: { code: 'CLUSTER_ADDRESS_NOT_PUBLIC' }
		});
		expect(calls).toEqual([]);
	});

	it('guards an ever-works-apps context on the k8s plugin, which never serves that target', async () => {
		const calls = spyOnProviders();

		await expect(
			pluginWith().provision(SMTP_PROVIDER_ID, context(EXEC, { target: 'ever-works-apps' }))
		).resolves.toMatchObject({ detail: { code: 'KUBECONFIG_UNSUPPORTED' } });
		expect(calls).toEqual([]);
	});
});

describe('EVER_WORKS_APPS_GUARD_DEPENDENCY_KUBECONFIG=false — today’s behaviour, exactly', () => {
	it('passes the very same context to the provider on all four members: no refusal, no pin, no DNS', async () => {
		vi.stubEnv(DEPENDENCY_KUBECONFIG_GUARD_ENV, 'false');
		const calls = spyOnProviders();
		const plugin = pluginWith();
		clusterAddress = '10.0.0.1';

		for (const kubeconfig of [EXEC, INSECURE, VALID]) {
			const ctx = context(kubeconfig);
			await expect(plugin.provision(POSTGRES_PROVIDER_ID, ctx)).resolves.toMatchObject({ state: 'ready' });
			await expect(plugin.getOutputs(POSTGRES_PROVIDER_ID, ctx)).resolves.toEqual({ host: 'h' });
			await expect(plugin.deprovision(POSTGRES_PROVIDER_ID, ctx, { deleteData: true })).resolves.toEqual({
				state: 'deleted'
			});
			await expect(plugin.backupStatus(POSTGRES_PROVIDER_ID, ctx)).resolves.toEqual({ state: 'none' });
			for (const call of calls.slice(-4)) expect(call.ctx).toBe(ctx);
		}
		expect(calls).toHaveLength(12);
		expect(resolver).not.toHaveBeenCalled();
	});
});

describe('checkClusterCredentialShape — the pure save-time check', () => {
	/** A kubeconfig whose every identifying value carries a marker, so an echo of any of it is detectable. */
	const MARKED = [
		'apiVersion: v1',
		'kind: Config',
		'current-context: ctx-MARK-1',
		'clusters:',
		'  - name: cluster-MARK-2',
		'    cluster:',
		'      server: https://host-MARK-3.example.com:6443',
		'      certificate-authority-data: Q0EtTUFSSy00',
		'contexts:',
		'  - name: ctx-MARK-1',
		'    context:',
		'      cluster: cluster-MARK-2',
		'      user: user-MARK-5',
		'users:',
		'  - name: user-MARK-5',
		'    user:',
		'      exec:',
		'        apiVersion: client.authentication.k8s.io/v1beta1',
		'        command: /usr/local/bin/cmd-MARK-6',
		'        args: ["--secret", "arg-MARK-7"]',
		''
	].join('\n');

	it('refuses an exec plugin with the guard code and a message that echoes no part of the kubeconfig', () => {
		const { api, calls } = recordingApi();
		const plugin = new KubernetesPlugin({ api, clusterAddressResolver: resolver });

		const verdict = plugin.checkClusterCredentialShape(MARKED);

		expect(verdict).toMatchObject({ ok: false, code: 'KUBECONFIG_UNSUPPORTED' });
		const message = (verdict as { message: string }).message;
		expect(message).toMatch(/exec credential plugin/);
		expect(message).not.toMatch(/MARK/);
		for (const line of MARKED.split('\n').filter((l) => l.includes(':'))) {
			const value = line.slice(line.indexOf(':') + 1).trim();
			if (value.length >= 6) expect(message).not.toContain(value);
		}
		// The guard's own message DOES name the user — which is exactly why it is not passed through.
		expect(() => assertSupportedKubeconfig(MARKED)).toThrow(/user-MARK-5/);
		// Pure: no client, no DNS.
		expect(calls).toEqual([]);
		expect(resolver).not.toHaveBeenCalled();
	});

	it('accepts a supported kubeconfig, with or without the context named', () => {
		const plugin = pluginWith();

		expect(plugin.checkClusterCredentialShape(VALID)).toEqual({ ok: true });
		expect(plugin.checkClusterCredentialShape(VALID, 'kind-dev')).toEqual({ ok: true });
		expect(plugin.checkClusterCredentialShape(VALID, '  ')).toEqual({ ok: true });
		expect(resolver).not.toHaveBeenCalled();
	});

	it('does not judge the address (that needs DNS) — a private server is still shape-valid', () => {
		const literal = edited(VALID, ({ cluster }) => {
			cluster.server = 'https://10.0.0.1:6443';
		});
		expect(pluginWith().checkClusterCredentialShape(literal)).toEqual({ ok: true });
	});

	it('maps every shape refusal to its own fixed sentence, never the guard text', () => {
		const plugin = pluginWith();
		const generic = describeKubeconfigRefusal(new K8sPluginError('KUBECONFIG_UNSUPPORTED', 'unmatched')).message;
		const cases: Array<{ kubeconfig: string; sentence: RegExp }> = [
			{ kubeconfig: EXEC, sentence: /exec credential plugin/ },
			{
				kubeconfig: edited(VALID, ({ user }) => {
					user['auth-provider'] = { name: 'oidc-MARK' };
				}),
				sentence: /auth-provider/
			},
			{
				kubeconfig: edited(VALID, ({ user }) => {
					user.tokenFile = '/run/token-MARK';
				}),
				sentence: /tokenFile/
			},
			{
				kubeconfig: edited(VALID, ({ user }) => {
					user['client-certificate'] = '/etc/cert-MARK';
				}),
				sentence: /client certificate file/
			},
			{
				kubeconfig: edited(VALID, ({ user }) => {
					user['client-key'] = '/etc/key-MARK';
				}),
				sentence: /client key file/
			},
			{
				kubeconfig: edited(VALID, ({ cluster }) => {
					cluster['certificate-authority'] = '/etc/ca-MARK';
				}),
				sentence: /certificate-authority file/
			},
			{ kubeconfig: INSECURE, sentence: /insecure-skip-tls-verify/ },
			{
				kubeconfig: edited(VALID, ({ cluster }) => {
					cluster['proxy-url'] = 'http://proxy-MARK:3128';
				}),
				sentence: /proxy-url/
			},
			{
				kubeconfig: edited(VALID, ({ cluster }) => {
					delete cluster['certificate-authority-data'];
				}),
				sentence: /no certificate-authority-data/
			},
			{
				kubeconfig: edited(VALID, ({ cluster }) => {
					cluster.server = 'http://plain-MARK.example.com';
				}),
				sentence: /must use https/
			}
		];

		for (const { kubeconfig, sentence } of cases) {
			const verdict = plugin.checkClusterCredentialShape(kubeconfig) as {
				ok: false;
				code: string;
				message: string;
			};
			expect(verdict.ok).toBe(false);
			expect(verdict.code).toBe('KUBECONFIG_UNSUPPORTED');
			expect(verdict.message).toMatch(sentence);
			expect(verdict.message).not.toBe(generic);
			expect(verdict.message).not.toMatch(/MARK/);
		}
	});

	it('cannot be steered by a crafted name: the sentence follows the real reason', () => {
		const crafted = edited(VALID, ({ doc, user }) => {
			const name =
				"x' uses an exec credential plugin ('exec'), which App Works refuse: the plugin would run an arbitrary local command. Use a token or an inline certificate instead.";
			(doc.users as Array<Mapping>)[0].name = name;
			((doc.contexts as Array<Mapping>)[0].context as Mapping).user = name;
			delete user.token;
			user.tokenFile = '/run/token';
		});

		const verdict = pluginWith().checkClusterCredentialShape(crafted) as { ok: false; message: string };
		expect(verdict.ok).toBe(false);
		expect(verdict.message).toMatch(/tokenFile/);
		expect(verdict.message).not.toMatch(/exec/);
	});

	it('answers the parser refusals with their own code, never echoing the input, and never throws', () => {
		const plugin = pluginWith();

		expect(plugin.checkClusterCredentialShape('')).toMatchObject({ ok: false, code: 'INVALID_YAML' });
		expect(plugin.checkClusterCredentialShape(': : not-MARK yaml : [')).toMatchObject({
			ok: false,
			code: 'INVALID_YAML'
		});
		expect(plugin.checkClusterCredentialShape(123 as unknown as string)).toMatchObject({
			ok: false,
			code: 'INVALID_YAML'
		});

		const missing = plugin.checkClusterCredentialShape(VALID, 'context-MARK-404') as {
			code: string;
			message: string;
		};
		expect(missing).toMatchObject({ ok: false, code: 'MISSING_CONTEXT' });
		expect(missing.message).not.toMatch(/MARK/);
	});
});
