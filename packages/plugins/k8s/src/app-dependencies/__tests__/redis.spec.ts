/**
 * T20 — `app-dependencies/redis.provider.ts` (plan §4.9:617, §4.9:575-602, §4.9:604-611, §4.9:620-628;
 * spec FR-36/FR-37/FR-38/FR-40/FR-41/FR-43/FR-48, ACC-07-16; APW07-G01, APW07-G10).
 *
 * Every clause of T20's `**Test**` line has an `it` below: a Deployment without persistence and a
 * StatefulSet with a 1 GiB PVC; `--maxmemory 400mb` with the declared policy; a readiness probe that uses
 * `REDISCLI_AUTH` and never puts the password in an argument; ready when `readyReplicas == 1` inside the
 * five-minute deadline (ACC-07-16); the `redis://…` URL shape; and `dep-redis` admitting same-namespace
 * ingress only and being applied **before** the workload (APW07-G01).
 *
 * It also covers the rest of T20's `**Create**` line for this file — the outputs, deprovision including
 * `stopWorkloads` (R-15), the ephemeral variant (R-10) and the cluster-permission failure — because those
 * are behaviours of the same file, and the plugin's own registration of the provider.
 *
 * **No network, ever.** `FakeDependencyCluster` (the shared `__tests__/dependency-cluster.fake.ts`)
 * implements the five-method `AppDependencyApi` port over an in-memory object list with
 * Server-Side-Apply merge semantics, and the provider's clock, its only wait and its poll interval are all
 * injected — so "not ready yet" costs one loop, not five minutes.
 */
import { describe, expect, it } from 'vitest';

import type { AppDependencyContext } from '@ever-works/plugin';

import { K8sPluginError } from '../../errors';
import { KubernetesPlugin } from '../../k8s.plugin';
import { APP_DEPENDENCY_POLICY_LABEL } from '../../app/app-network-policy.renderer';
import {
	APP_LABEL_KIND,
	APP_LABEL_KIND_APP,
	APP_LABEL_MANAGED_BY,
	APP_LABEL_PART_OF,
	APP_LABEL_RETAIN,
	APP_LABEL_WORK_ID,
	APP_MANAGED_BY,
	dependencyNetworkPolicyName
} from '../../app/app-names';
import { APP_DEPENDENCY_PORTS } from '../common';
import { REDIS_DEFAULT_VERSION, isDigestPinned } from '../images';
import {
	REDIS_MAXMEMORY,
	REDIS_MAXMEMORY_POLICY_DEFAULT,
	REDIS_MEMORY_LIMIT,
	REDIS_OBJECT_NAMES,
	REDIS_PORT,
	REDIS_PROVIDER_DESCRIPTOR,
	REDIS_PROVIDER_ID,
	RedisDependencyProvider,
	declaredMaxmemoryPolicy,
	declaredPersistence,
	declaredVersion,
	generatePassword,
	redisOutputs,
	redisServerArgs
} from '../redis.provider';
import { FakeDependencyCluster, type Json } from './dependency-cluster.fake';
import type { KubernetesApiService } from '../../k8s-api.service';

/* ------------------------------------------------------------------------- *
 * Fixtures
 * ------------------------------------------------------------------------- */

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const WORK_SLUG = 'analytics';
const NAMESPACE = 'ew-analytics-0f8e2c1a';
const KUBECONFIG = 'kind-app-runtime-kubeconfig';

function context(overrides: Json = {}): AppDependencyContext {
	const base: Json = {
		workId: WORK_ID,
		appName: WORK_SLUG,
		target: 'your-cluster',
		declared: { version: '7' },
		sizeGiB: 1,
		cluster: {
			kubeconfig: KUBECONFIG,
			context: null,
			namespace: NAMESPACE,
			appLabels: { [APP_LABEL_PART_OF]: WORK_SLUG }
		},
		settings: {},
		signal: new AbortController().signal
	};

	return { ...base, ...overrides } as unknown as AppDependencyContext;
}

/** The error `KubernetesApiService` raises for a 403: `scrubError`'s code, the original on `cause`. */
function forbidden(message = 'forbidden: statefulsets is forbidden'): K8sPluginError {
	return new K8sPluginError('UNAUTHORIZED', message, { statusCode: 403 });
}

/** A cluster with a default storage class — Redis never probes for one, and this proves it below. */
function redisCluster(): FakeDependencyCluster {
	const cluster = new FakeDependencyCluster();
	cluster.seedStorageClass('standard');
	return cluster;
}

/** A provider over the fake, with a clock that never sleeps. */
function provider(cluster: FakeDependencyCluster, options: Json = {}): RedisDependencyProvider {
	return new RedisDependencyProvider(cluster, {
		now: () => 0,
		sleep: async () => undefined,
		pollIntervalMs: 1,
		...options
	});
}

/** The fake as the service the plugin's constructor declares — the same cast `k8s.plugin.spec.ts` uses. */
function pluginOver(cluster: FakeDependencyCluster): KubernetesPlugin {
	return new KubernetesPlugin({ api: cluster as unknown as KubernetesApiService });
}

/** The password a provision stored, read out of the cluster rather than out of the outcome. */
function storedPassword(cluster: FakeDependencyCluster): string {
	const secret = cluster.stored('Secret').find((entry) => entry.metadata?.name === REDIS_OBJECT_NAMES.secret);
	return Buffer.from(String(secret?.data?.password ?? ''), 'base64').toString('utf8');
}

/* ------------------------------------------------------------------------- *
 * FR-36/FR-37: the two shapes
 * ------------------------------------------------------------------------- */

describe('T20 — the workload shape (FR-36, FR-37, ACC-07-16)', () => {
	it('provisions Redis 7 as a single-replica Deployment with no volume when persistence is not declared', async () => {
		const cluster = redisCluster();

		const outcome = await provider(cluster).provision(REDIS_PROVIDER_ID, context());

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(outcome.actualVersion).toBe('7');

		const deployment = cluster.appliedOf('Deployment')[0];
		expect(deployment).toBeDefined();
		expect(deployment.metadata.name).toBe(REDIS_OBJECT_NAMES.deployment);
		expect(deployment.metadata.namespace).toBe(NAMESPACE);
		expect(deployment.spec.replicas).toBe(1);
		// FR-36: "a single-replica cache (with a volume only when persistence is declared)". No claim, no
		// volume, and no StatefulSet either.
		expect(deployment.spec.volumeClaimTemplates).toBeUndefined();
		expect(deployment.spec.template.spec.volumes).toBeUndefined();
		expect(cluster.appliedOf('StatefulSet')).toEqual([]);
		expect(cluster.stored('PersistentVolumeClaim')).toEqual([]);

		const container = deployment.spec.template.spec.containers[0];
		expect(container.name).toBe('redis');
		expect(container.ports).toEqual([{ name: 'redis', containerPort: REDIS_PORT, protocol: 'TCP' }]);
		expect(container.resources.limits).toEqual({ memory: REDIS_MEMORY_LIMIT });
		// The image is the pinned Redis 7 digest — never a tag.
		expect(container.image).toContain('docker.io/library/redis@sha256:');
		expect(isDigestPinned(container.image)).toBe(true);
	});

	it('provisions a StatefulSet with a 1 GiB claim when persistence is declared', async () => {
		const cluster = redisCluster();

		const outcome = await provider(cluster).provision(
			REDIS_PROVIDER_ID,
			context({ declared: { version: '7', persistence: true } })
		);

		expect(outcome.state).toBe('ready');
		const statefulSet = cluster.appliedOf('StatefulSet')[0];
		expect(statefulSet).toBeDefined();
		expect(statefulSet.metadata.name).toBe(REDIS_OBJECT_NAMES.statefulSet);
		expect(statefulSet.spec.replicas).toBe(1);
		expect(statefulSet.spec.serviceName).toBe(REDIS_OBJECT_NAMES.service);
		expect(statefulSet.spec.volumeClaimTemplates).toHaveLength(1);
		// FR-37: Redis's volume default is 1 GiB, and the context declares no size of its own here.
		expect(statefulSet.spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe('1Gi');
		expect(statefulSet.spec.volumeClaimTemplates[0].metadata.name).toBe('data');
		expect(statefulSet.spec.template.spec.containers[0].volumeMounts).toEqual([
			{ name: 'data', mountPath: '/data' }
		]);
		expect(cluster.appliedOf('Deployment')).toEqual([]);
	});

	it('labels the claim retain so the volume survives its workload (R-15)', async () => {
		const cluster = redisCluster();

		await provider(cluster).provision(
			REDIS_PROVIDER_ID,
			context({ declared: { version: '7', persistence: true } })
		);

		const claim = cluster.appliedOf('StatefulSet')[0].spec.volumeClaimTemplates[0];
		// APW-06's label set plus `ever-works.io/dependency` plus `ever-works.io/retain: "true"` — the label
		// APW-06's `destroyApp` refuses to delete without `deleteVolumes` (plan §4.9:578).
		expect(claim.metadata.labels).toEqual({
			[APP_LABEL_MANAGED_BY]: APP_MANAGED_BY,
			[APP_LABEL_PART_OF]: WORK_SLUG,
			[APP_LABEL_WORK_ID]: WORK_ID,
			[APP_LABEL_KIND]: APP_LABEL_KIND_APP,
			[APP_DEPENDENCY_POLICY_LABEL]: 'redis',
			[APP_LABEL_RETAIN]: 'true'
		});
		// …and the PVC the cluster created from that template carries them, which is what the teardown finds.
		expect(cluster.stored('PersistentVolumeClaim')[0].metadata.labels).toEqual(claim.metadata.labels);
	});

	it("honours the owner's declared size and the plugin's default size setting (FR-37)", async () => {
		const declared = redisCluster();
		await provider(declared).provision(REDIS_PROVIDER_ID, context({ sizeGiB: 4, declared: { persistence: true } }));
		expect(declared.appliedOf('StatefulSet')[0].spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe(
			'4Gi'
		);

		// The setting only *seeds* the dialog (plan §4.9:631): with no owner choice, it is the size.
		const fromSettings = redisCluster();
		await provider(fromSettings).provision(
			REDIS_PROVIDER_ID,
			context({
				sizeGiB: undefined,
				settings: { appDependencySizes: { redis: 3 } },
				declared: { persistence: true }
			})
		);
		expect(
			fromSettings.appliedOf('StatefulSet')[0].spec.volumeClaimTemplates[0].spec.resources.requests.storage
		).toBe('3Gi');
	});

	it('renders one ClusterIP Service on 6379 — never a LoadBalancer or a NodePort (plan §4.9:580)', async () => {
		const cluster = redisCluster();

		await provider(cluster).provision(REDIS_PROVIDER_ID, context());

		const services = cluster.appliedOf('Service');
		expect(services).toHaveLength(1);
		expect(services[0].metadata.name).toBe(REDIS_OBJECT_NAMES.service);
		expect(services[0].spec.type).toBe('ClusterIP');
		expect(services[0].spec.selector).toEqual({ [APP_DEPENDENCY_POLICY_LABEL]: 'redis' });
		expect(services[0].spec.ports).toEqual([
			{ name: 'redis', port: REDIS_PORT, targetPort: REDIS_PORT, protocol: 'TCP' }
		]);
		expect(cluster.appliedOf('Service').map((entry) => entry.spec.type)).not.toContain('LoadBalancer');
		expect(cluster.appliedOf('Service').map((entry) => entry.spec.type)).not.toContain('NodePort');
	});

	it('honours an admin image override and never needs a default storage class it does not claim', async () => {
		const cluster = redisCluster();
		const override = 'sha256:' + 'c'.repeat(64);
		// A cluster with no default class at all: Redis-without-persistence claims nothing, so this is fine
		// (only the Postgres path fails on `noDefaultStorageClass` — ACC-07-20 belongs to T19).
		const bare = new FakeDependencyCluster();

		await provider(cluster).provision(
			REDIS_PROVIDER_ID,
			context({ settings: { appDependencyImages: { redis: override } } })
		);
		expect(cluster.appliedOf('Deployment')[0].spec.template.spec.containers[0].image).toBe(
			`docker.io/library/redis@${override}`
		);

		expect((await provider(bare).provision(REDIS_PROVIDER_ID, context())).state).toBe('ready');
		expect(bare.ops('list').filter((call) => call.kind === 'StorageClass')).toEqual([]);
	});
});

/* ------------------------------------------------------------------------- *
 * plan §4.9:617: the args and the credential
 * ------------------------------------------------------------------------- */

describe('T20 — the args and the readiness probe (plan §4.9:617)', () => {
	it('passes --requirepass $(REDIS_PASSWORD), --maxmemory 400mb and the declared policy', async () => {
		const cluster = redisCluster();

		await provider(cluster).provision(REDIS_PROVIDER_ID, context());

		const args = cluster.appliedOf('Deployment')[0].spec.template.spec.containers[0].args;
		expect(args).toEqual([
			'--requirepass',
			'$(REDIS_PASSWORD)',
			'--maxmemory',
			REDIS_MAXMEMORY,
			'--maxmemory-policy',
			REDIS_MAXMEMORY_POLICY_DEFAULT
		]);
		expect(REDIS_MAXMEMORY).toBe('400mb');
		expect(args).toEqual(redisServerArgs({ maxmemoryPolicy: 'noeviction', persistence: false }));
	});

	it('follows the declared maxmemory policy and refuses a value outside the App spec’s enum', async () => {
		const declared = redisCluster();
		await provider(declared).provision(
			REDIS_PROVIDER_ID,
			context({ declared: { version: '7', maxmemoryPolicy: 'allkeys-lru' } })
		);
		expect(declared.appliedOf('Deployment')[0].spec.template.spec.containers[0].args).toContain('allkeys-lru');

		// A declaration reaches `redis-server --maxmemory-policy`, so anything outside the schema's enum is
		// dropped for the documented default with a warning — never passed through.
		const bogus = redisCluster();
		const outcome = await provider(bogus).provision(
			REDIS_PROVIDER_ID,
			context({ declared: { version: '7', maxmemoryPolicy: '--requirepass hacked' } })
		);
		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(outcome.warnings).toContain('maxmemoryPolicyUnsupported=--requirepass hacked');
		const args = bogus.appliedOf('Deployment')[0].spec.template.spec.containers[0].args;
		expect(args).not.toContain('--requirepass hacked');
		expect(args[args.indexOf('--maxmemory-policy') + 1]).toBe(REDIS_MAXMEMORY_POLICY_DEFAULT);
	});

	it('reads REDISCLI_AUTH from the Secret and never puts the password in an argument or a probe', async () => {
		const cluster = redisCluster();

		const outcome = await provider(cluster).provision(REDIS_PROVIDER_ID, context());
		expect(outcome.state).toBe('ready');

		const container = cluster.appliedOf('Deployment')[0].spec.template.spec.containers[0];
		const password = storedPassword(cluster);
		expect(password).toMatch(/^[0-9a-f]{32}$/);

		// The probe is `redis-cli ping` and nothing else: `REDISCLI_AUTH` is what authenticates it.
		expect(container.readinessProbe.exec.command).toEqual(['redis-cli', 'ping']);
		expect(container.env).toEqual(
			expect.arrayContaining([
				{
					name: 'REDIS_PASSWORD',
					valueFrom: { secretKeyRef: { name: REDIS_OBJECT_NAMES.secret, key: 'password' } }
				},
				{
					name: 'REDISCLI_AUTH',
					valueFrom: { secretKeyRef: { name: REDIS_OBJECT_NAMES.secret, key: 'password' } }
				}
			])
		);
		// `$(REDIS_PASSWORD)` is the kubelet's dependent-variable reference; the value is nowhere in the pod.
		expect(container.args).toContain('$(REDIS_PASSWORD)');
		expect(JSON.stringify(container)).not.toContain(password);
		expect(JSON.stringify(container.readinessProbe)).not.toContain(password);
		// The Secret carries it under `data`, base64 — what a later read returns is what was written.
		const secret = cluster.stored('Secret').find((entry) => entry.metadata?.name === REDIS_OBJECT_NAMES.secret);
		expect(secret?.data?.password).toBe(Buffer.from(password, 'utf8').toString('base64'));
	});

	it('appends --appendonly yes only on the persisted shape (plan §4.9:617)', async () => {
		const transient = redisCluster();
		await provider(transient).provision(REDIS_PROVIDER_ID, context());
		expect(transient.appliedOf('Deployment')[0].spec.template.spec.containers[0].args).not.toContain(
			'--appendonly'
		);

		const persisted = redisCluster();
		await provider(persisted).provision(
			REDIS_PROVIDER_ID,
			context({ declared: { version: '7', persistence: true } })
		);
		const args = persisted.appliedOf('StatefulSet')[0].spec.template.spec.containers[0].args;
		expect(args.slice(-2)).toEqual(['--appendonly', 'yes']);
	});
});

/* ------------------------------------------------------------------------- *
 * FR-41/FR-43, ACC-07-16: readiness
 * ------------------------------------------------------------------------- */

describe('T20 — readiness (FR-41, FR-43, ACC-07-16)', () => {
	it('is ready the moment the workload reports one ready replica', async () => {
		const cluster = redisCluster();
		cluster.readyReplicas = 0;
		let polls = 0;

		const outcome = await provider(cluster, {
			sleep: async () => {
				polls += 1;
				// The controller catches up on the third observation — the loop is what waits, not a sleep.
				if (polls === 3) cluster.readyReplicas = 1;
			}
		}).provision(REDIS_PROVIDER_ID, context());

		expect(outcome.state).toBe('ready');
		expect(polls).toBe(3);
		expect(cluster.ops('read').filter((call) => call.kind === 'Deployment').length).toBe(4);
	});

	it('fails at the caller’s deadline — Redis’s five minutes — and reports it as definite', async () => {
		const cluster = redisCluster();
		cluster.readyReplicas = 0;
		const controller = new AbortController();
		const deadlineMs = 5 * 60_000;
		let now = 0;
		let polls = 0;

		const outcome = await provider(cluster, {
			now: () => now,
			// The real poll interval, so the virtual clock reaches the deadline in 60 observations.
			pollIntervalMs: 5_000,
			// The provisioning job's own timer: FR-41's five minutes for Redis
			// (`APP_DEPENDENCY_READY_DEADLINE_MS.redis`), which reaches the provider as this abort.
			sleep: async (millis: number) => {
				polls += 1;
				now += millis;
				if (now >= deadlineMs) controller.abort();
			}
		}).provision(REDIS_PROVIDER_ID, context({ signal: controller.signal }));

		expect(polls).toBe(60);
		expect(now).toBe(deadlineMs);
		expect(outcome).toMatchObject({ state: 'failed', reason: 'deadlineExceeded', transient: false });
	});

	it('fails volumeNotReady when a persisted Redis never becomes ready', async () => {
		const cluster = redisCluster();
		cluster.readyReplicas = 0;
		const controller = new AbortController();

		const outcome = await provider(cluster, {
			sleep: async () => controller.abort()
		}).provision(
			REDIS_PROVIDER_ID,
			context({ declared: { version: '7', persistence: true }, signal: controller.signal })
		);

		// The claim is the one thing that can keep the pod unschedulable, so the card names the volume.
		expect(outcome).toMatchObject({ state: 'failed', reason: 'volumeNotReady', transient: false });
	});

	it('answers pending, never a tight loop, when a caller forgets to arm the deadline signal', async () => {
		const cluster = redisCluster();
		cluster.readyReplicas = 0;
		let polls = 0;

		const outcome = await provider(cluster, {
			maxPolls: 4,
			sleep: async () => {
				polls += 1;
			}
		}).provision(REDIS_PROVIDER_ID, context());

		expect(polls).toBe(3);
		expect(outcome).toMatchObject({ state: 'pending', retryAfterMs: 1 });
	});

	it('fails clusterPermissionMissing when the credential may not create the workload (APW07-G10)', async () => {
		const cluster = redisCluster();
		cluster.applyFails.set('Deployment', forbidden('forbidden: deployments is forbidden'));

		const outcome = await provider(cluster).provision(REDIS_PROVIDER_ID, context());

		expect(outcome).toMatchObject({
			state: 'failed',
			reason: 'clusterPermissionMissing',
			transient: false,
			detail: { resource: 'deployments', verb: 'create', namespace: NAMESPACE }
		});
		// The refusal happened after the policy — the objects before the workload are the ones FR-38 needs.
		expect(cluster.appliedNames()[0]).toBe('NetworkPolicy/dep-redis');

		const persisted = redisCluster();
		persisted.applyFails.set('StatefulSet', forbidden());
		const persistedOutcome = await provider(persisted).provision(
			REDIS_PROVIDER_ID,
			context({ declared: { persistence: true } })
		);
		expect(persistedOutcome).toMatchObject({ detail: { resource: 'statefulsets' } });
	});
});

/* ------------------------------------------------------------------------- *
 * FR-38 / APW07-G01: the policy goes first
 * ------------------------------------------------------------------------- */

describe('T20 — the dep-redis NetworkPolicy (FR-38, APW07-G01)', () => {
	it('applies dep-redis before the workload, admitting same-namespace pods on 6379 only', async () => {
		const cluster = redisCluster();

		await provider(cluster).provision(REDIS_PROVIDER_ID, context());

		expect(cluster.appliedNames()[0]).toBe('NetworkPolicy/dep-redis');
		const names = cluster.appliedNames();
		expect(names.indexOf('NetworkPolicy/dep-redis')).toBeLessThan(names.indexOf('Deployment/dep-redis'));
		// …and before the Secret and the Service too: nothing a pod can reach comes into being unguarded.
		expect(names.indexOf('NetworkPolicy/dep-redis')).toBeLessThan(names.indexOf('Secret/dep-redis'));
		expect(names.indexOf('NetworkPolicy/dep-redis')).toBeLessThan(names.indexOf('Service/dep-redis'));

		const policy = cluster.appliedOf('NetworkPolicy')[0];
		expect(policy.metadata.name).toBe(dependencyNetworkPolicyName('redis'));
		expect(policy.spec.podSelector).toEqual({ matchLabels: { [APP_DEPENDENCY_POLICY_LABEL]: 'redis' } });
		expect(policy.spec.policyTypes).toEqual(['Ingress']);
		expect(policy.spec.ingress).toEqual([
			{ from: [{ podSelector: {} }], ports: [{ protocol: 'TCP', port: APP_DEPENDENCY_PORTS.redis }] }
		]);
		// No operator path for Redis, so no second rule and no `operatorNamespaceUnknown` warning.
		expect(cluster.appliedOf('NetworkPolicy')).toHaveLength(1);
	});

	it('draws the policy with isolation off too — the context carries no isolation switch (APW07-G01)', async () => {
		const strict = redisCluster();
		const switchedOff = redisCluster();

		await provider(strict).provision(REDIS_PROVIDER_ID, context());
		// An App Work whose isolation setting is off, plus anything else a caller might carry on the context.
		await provider(switchedOff).provision(
			REDIS_PROVIDER_ID,
			context({ isolation: false, appWorkIsolation: false })
		);

		expect(switchedOff.appliedOf('NetworkPolicy')[0]).toEqual(strict.appliedOf('NetworkPolicy')[0]);
		expect(switchedOff.appliedNames()[0]).toBe('NetworkPolicy/dep-redis');
	});
});

/* ------------------------------------------------------------------------- *
 * FR-40/FR-42: the outputs
 * ------------------------------------------------------------------------- */

describe('T20 — the outputs (FR-40, FR-42)', () => {
	it('emits host, port, password and the redis:// URL shape', async () => {
		const cluster = redisCluster();

		const outcome = await provider(cluster).provision(REDIS_PROVIDER_ID, context());
		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;

		const password = outcome.outputs?.password ?? '';
		expect(outcome.outputs).toEqual({
			host: `dep-redis.${NAMESPACE}.svc.cluster.local`,
			port: '6379',
			password,
			url: `redis://:${password}@dep-redis.${NAMESPACE}.svc.cluster.local:6379/0`
		});
		// Exactly FR-40's four names — no extra key and no missing one.
		expect(Object.keys(outcome.outputs ?? {}).sort()).toEqual(['host', 'password', 'port', 'url']);
		expect(outcome.resourceRefs?.namespace).toBe(NAMESPACE);
		expect(outcome.resourceRefs?.objects).toEqual([
			{ kind: 'NetworkPolicy', name: 'dep-redis' },
			{ kind: 'Secret', name: 'dep-redis' },
			{ kind: 'Service', name: 'dep-redis' },
			{ kind: 'Deployment', name: 'dep-redis' }
		]);
	});

	it('reads the outputs back out of the cluster, never out of the provision result (FR-42)', async () => {
		const cluster = redisCluster();
		await provider(cluster).provision(REDIS_PROVIDER_ID, context());

		// An operator rotation by hand is exactly what a `refresh` must see.
		cluster.seed({
			apiVersion: 'v1',
			kind: 'Secret',
			metadata: { name: REDIS_OBJECT_NAMES.secret, namespace: NAMESPACE },
			data: { password: Buffer.from('rotated-by-hand', 'utf8').toString('base64') }
		});

		const outputs = await provider(cluster).getOutputs(REDIS_PROVIDER_ID, context());

		expect(outputs.password).toBe('rotated-by-hand');
		expect(outputs.url).toBe(`redis://:rotated-by-hand@dep-redis.${NAMESPACE}.svc.cluster.local:6379/0`);
	});

	it('throws rather than answering an empty output set when the Secret is gone (plan §9.2:955)', async () => {
		const cluster = redisCluster();

		await expect(provider(cluster).getOutputs(REDIS_PROVIDER_ID, context())).rejects.toThrow(/dep-redis/);
	});

	it('never rotates a password the cluster already has (FR-47)', async () => {
		const cluster = redisCluster();
		await provider(cluster).provision(REDIS_PROVIDER_ID, context());
		const first = storedPassword(cluster);

		await provider(cluster).provision(REDIS_PROVIDER_ID, context());

		const applied = cluster
			.appliedOf('Secret')
			.filter((entry) => entry.metadata.name === REDIS_OBJECT_NAMES.secret)
			.map((entry) => Buffer.from(String(entry.data.password), 'base64').toString('utf8'));
		expect(applied).toEqual([first, first]);
		expect(new Set(applied).size).toBe(1);
	});

	it('answers with a typed error for a provider id it does not serve', async () => {
		const cluster = redisCluster();

		await expect(provider(cluster).getOutputs('k8s-inline-postgres', context())).rejects.toThrow(
			/k8s-inline-postgres/
		);
		expect(await provider(cluster).provision('k8s-inline-postgres', context())).toMatchObject({
			state: 'failed',
			reason: 'providerNotSupported'
		});
		expect(await provider(cluster).supports('postgres', 'your-cluster')).toEqual({
			supported: false,
			reason: 'providerNotSupported'
		});
	});
});

/* ------------------------------------------------------------------------- *
 * FR-48 / plan §4.9:624-628: backup state and deprovision
 * ------------------------------------------------------------------------- */

describe('T20 — backup state and deprovision (FR-48, plan §4.9:624-628)', () => {
	it('reports backup state none without touching the cluster (FR-48)', async () => {
		const cluster = redisCluster();
		await provider(cluster).provision(REDIS_PROVIDER_ID, context());
		const before = cluster.calls.length;

		expect(await provider(cluster).backupStatus(REDIS_PROVIDER_ID, context())).toEqual({ state: 'none' });
		expect(cluster.calls.length).toBe(before);
	});

	it('makes no cluster call at all when data is kept and the workload is not stopped', async () => {
		const cluster = redisCluster();
		await provider(cluster).provision(REDIS_PROVIDER_ID, context());
		const before = cluster.calls.length;

		const outcome = await provider(cluster).deprovision(REDIS_PROVIDER_ID, context(), { deleteData: false });

		expect(outcome).toEqual({ state: 'released' });
		expect(cluster.calls.length).toBe(before);
	});

	it('scales the workload to zero for stopWorkloads and touches nothing else', async () => {
		const cluster = redisCluster();
		await provider(cluster).provision(
			REDIS_PROVIDER_ID,
			context({ declared: { version: '7', persistence: true } })
		);

		const outcome = await provider(cluster).deprovision(REDIS_PROVIDER_ID, context(), {
			deleteData: false,
			stopWorkloads: true
		});

		expect(outcome).toEqual({ state: 'released' });
		expect(cluster.applied().at(-1)).toMatchObject({ kind: 'StatefulSet', spec: { replicas: 0 } });
		// R-15: nothing is deleted — not the PVC, not the Secret, not the policy. The data survives.
		expect(cluster.deleted()).toEqual([]);
		expect(cluster.stored('PersistentVolumeClaim')).toHaveLength(1);
		expect(cluster.stored('Secret').some((entry) => entry.metadata?.name === REDIS_OBJECT_NAMES.secret)).toBe(true);
		expect(cluster.stored('NetworkPolicy').some((entry) => entry.metadata?.name === 'dep-redis')).toBe(true);
		expect((await provider(cluster).getOutputs(REDIS_PROVIDER_ID, context())).password).toBe(
			storedPassword(cluster)
		);
	});

	it('scales a Deployment-shaped cache too, whichever shape the cluster has', async () => {
		const cluster = redisCluster();
		await provider(cluster).provision(REDIS_PROVIDER_ID, context());

		await provider(cluster).deprovision(REDIS_PROVIDER_ID, context(), { deleteData: false, stopWorkloads: true });

		expect(cluster.applied().at(-1)).toMatchObject({ kind: 'Deployment', spec: { replicas: 0 } });
		expect(cluster.deleted()).toEqual([]);
	});

	it('deletes the workload, the Service, the Secret, the policy and the PVC when data is deleted', async () => {
		const cluster = redisCluster();
		await provider(cluster).provision(
			REDIS_PROVIDER_ID,
			context({ declared: { version: '7', persistence: true } })
		);

		const outcome = await provider(cluster).deprovision(REDIS_PROVIDER_ID, context(), { deleteData: true });

		expect(outcome).toEqual({ state: 'deleted' });
		const deleted = cluster.deleted();
		expect(deleted).toEqual(
			expect.arrayContaining([
				'NetworkPolicy/dep-redis',
				'StatefulSet/dep-redis',
				'Secret/dep-redis',
				'Service/dep-redis',
				'PersistentVolumeClaim/dep-redis-data-0'
			])
		);
		// The PVC is deleted explicitly, after the workload — never merely orphaned with its StatefulSet.
		expect(deleted[deleted.length - 1]).toBe('PersistentVolumeClaim/dep-redis-data-0');
		// And the label scan ran again *after* the deletes: `deleted` means "a fresh listing found nothing".
		const pvcCalls = cluster.calls.filter((call) => call.kind === 'PersistentVolumeClaim');
		expect(pvcCalls.filter((call) => call.op === 'delete').length).toBeGreaterThan(0);
		expect(pvcCalls.at(-1)?.op).toBe('list');
	});

	it('deletes the Deployment shape when nothing was persisted', async () => {
		const cluster = redisCluster();
		await provider(cluster).provision(REDIS_PROVIDER_ID, context());

		const outcome = await provider(cluster).deprovision(REDIS_PROVIDER_ID, context(), { deleteData: true });

		expect(outcome).toEqual({ state: 'deleted' });
		expect(cluster.deleted()).toEqual(
			expect.arrayContaining(['Deployment/dep-redis', 'Secret/dep-redis', 'Service/dep-redis'])
		);
	});

	it('reports remaining when something survives the teardown', async () => {
		const cluster = redisCluster();
		await provider(cluster).provision(
			REDIS_PROVIDER_ID,
			context({ declared: { version: '7', persistence: true } })
		);
		// A PVC that refuses to go, as a finalizer would make it.
		const original = cluster.deleteObject.bind(cluster);
		cluster.deleteObject = (async (
			kubeconfig: string,
			apiVersion: string,
			kind: string,
			namespace: string,
			name: string
		) => {
			if (kind !== 'PersistentVolumeClaim') return original(kubeconfig, apiVersion, kind, namespace, name);
			return undefined;
		}) as typeof cluster.deleteObject;

		const outcome = await provider(cluster).deprovision(REDIS_PROVIDER_ID, context(), { deleteData: true });

		expect(outcome.state).toBe('pending');
		expect(outcome.remaining?.objects).toEqual([{ kind: 'PersistentVolumeClaim', name: 'dep-redis-data-0' }]);
	});
});

/* ------------------------------------------------------------------------- *
 * R-10 / FR-60: the ephemeral variant
 * ------------------------------------------------------------------------- */

describe('T20 — the ephemeral variant (R-10, FR-60, ACC-07-31)', () => {
	it('uses emptyDir and no PVC, and says so', async () => {
		const cluster = redisCluster();

		const outcome = await provider(cluster).provision(REDIS_PROVIDER_ID, context({ ephemeral: true }));

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(outcome.warnings).toContain('ephemeralNoPersistence');
		expect(cluster.stored('PersistentVolumeClaim')).toEqual([]);
		expect(cluster.appliedOf('Deployment')[0].spec.template.spec.volumes).toBeUndefined();
	});

	it('uses an emptyDir even when persistence is declared — nothing outlives the namespace', async () => {
		const cluster = redisCluster();

		const outcome = await provider(cluster).provision(
			REDIS_PROVIDER_ID,
			context({ ephemeral: true, declared: { version: '7', persistence: true } })
		);

		expect(outcome.state).toBe('ready');
		const statefulSet = cluster.appliedOf('StatefulSet')[0];
		expect(statefulSet.spec.volumeClaimTemplates).toBeUndefined();
		expect(statefulSet.spec.template.spec.volumes).toEqual([{ name: 'data', emptyDir: {} }]);
		expect(JSON.stringify(statefulSet)).not.toContain('PersistentVolumeClaim');
		expect(cluster.stored('PersistentVolumeClaim')).toEqual([]);
	});
});

/* ------------------------------------------------------------------------- *
 * The declension of one App spec block
 * ------------------------------------------------------------------------- */

describe('T20 — the declared block, read defensively', () => {
	it('reduces the declared version to 7, or the pinned default with a warning', () => {
		const warnings: string[] = [];

		expect(declaredVersion(context())).toBe('7');
		expect(declaredVersion(context({ declared: { version: 7 } }), warnings)).toBe('7');
		expect(warnings).toEqual([]);
		expect(declaredVersion(context({ declared: {} }), warnings)).toBe(String(REDIS_DEFAULT_VERSION));
		expect(declaredVersion(context({ declared: { version: '6' } }), warnings)).toBe('7');
		expect(warnings).toEqual(['redisVersionUnsupported=6']);
	});

	it('reads persistence as the boolean true and nothing else', () => {
		expect(declaredPersistence(context({ declared: { persistence: true } }))).toBe(true);
		expect(declaredPersistence(context())).toBe(false);
		expect(declaredPersistence(context({ declared: { persistence: 'false' } }))).toBe(false);
		expect(declaredPersistence(context({ declared: { persistence: 1 } }))).toBe(false);
	});

	it('keeps every declared policy and warns about an unknown one', () => {
		const warnings: string[] = [];

		for (const policy of ['noeviction', 'allkeys-lru', 'volatile-lru', 'allkeys-lfu', 'volatile-lfu']) {
			expect(declaredMaxmemoryPolicy(context({ declared: { maxmemoryPolicy: policy } }), warnings)).toBe(policy);
		}
		expect(warnings).toEqual([]);
		expect(declaredMaxmemoryPolicy(context({ declared: { maxmemoryPolicy: 'allkeys-random' } }), warnings)).toBe(
			REDIS_MAXMEMORY_POLICY_DEFAULT
		);
		expect(warnings).toEqual(['maxmemoryPolicyUnsupported=allkeys-random']);
	});

	it('builds the URL from the Service DNS name, the port and the password', () => {
		const outputs = redisOutputs({ kubeconfig: KUBECONFIG, namespace: NAMESPACE, workSlug: WORK_SLUG }, 'abc');

		expect(outputs).toEqual({
			host: `dep-redis.${NAMESPACE}.svc.cluster.local`,
			port: '6379',
			password: 'abc',
			url: `redis://:abc@dep-redis.${NAMESPACE}.svc.cluster.local:6379/0`
		});
	});

	it('generates a 32-hex password with no two calls alike', () => {
		expect(generatePassword()).toMatch(/^[0-9a-f]{32}$/);
		expect(generatePassword()).not.toBe(generatePassword());
	});
});

/* ------------------------------------------------------------------------- *
 * plan §4.9:570 / tasks.md:311: the plugin's own wiring
 * ------------------------------------------------------------------------- */

describe('T20 — the k8s plugin publishes and delegates (plan §4.9:570, tasks.md:311)', () => {
	it('publishes the redis descriptor, with the plan’s preference and backup policy', () => {
		const plugin = new KubernetesPlugin();

		expect(plugin.dependencyProviders).toContainEqual(REDIS_PROVIDER_DESCRIPTOR);
		expect(REDIS_PROVIDER_DESCRIPTOR).toEqual({
			id: 'k8s-inline-redis',
			kind: 'redis',
			targets: ['your-cluster'],
			label: 'In your cluster · single instance',
			preference: 10,
			backupPolicy: 'none'
		});
	});

	it('answers supports for the pair it serves and for nothing else', async () => {
		const plugin = pluginOver(redisCluster());

		expect(await plugin.supports('redis', 'your-cluster', context())).toEqual({
			supported: true,
			providerId: REDIS_PROVIDER_ID
		});
		// R-5: never the managed tier (APW-10's `managed-redis` is), never another kind.
		expect(await plugin.supports('redis', 'ever-works-apps', context())).toEqual({
			supported: false,
			reason: 'providerNotSupported'
		});
		expect(await plugin.supports('objectStorage', 'your-cluster', context())).toEqual({
			supported: true,
			providerId: 'k8s-inline-minio'
		});
	});

	it('delegates provision, getOutputs, deprovision and backupStatus to the three providers by id', async () => {
		const cluster = redisCluster();
		const plugin = pluginOver(cluster);

		const outcome = await plugin.provision(REDIS_PROVIDER_ID, context());
		expect(outcome.state).toBe('ready');
		// Going through the plugin, the `dep-redis` policy is still applied first.
		expect(cluster.appliedNames()[0]).toBe('NetworkPolicy/dep-redis');

		expect(await plugin.getOutputs(REDIS_PROVIDER_ID, context())).toMatchObject({ port: '6379' });
		expect(await plugin.backupStatus(REDIS_PROVIDER_ID, context())).toEqual({ state: 'none' });
		expect(await plugin.deprovision(REDIS_PROVIDER_ID, context(), { deleteData: false })).toEqual({
			state: 'released'
		});
	});

	it('keeps each id on its own provider — a lookup that collapsed would be the bug it guards', async () => {
		const cluster = redisCluster();
		const plugin = pluginOver(cluster);

		await plugin.provision('k8s-inline-postgres', context({ declared: { version: 16 } }));
		expect(cluster.appliedOf('StatefulSet').map((entry) => entry.metadata.name)).toEqual(['dep-postgres']);

		await plugin.provision('k8s-inline-minio', context({ declared: { buckets: ['uploads'] } }));
		expect(cluster.appliedNames()).toContain('NetworkPolicy/dep-s3');

		await plugin.provision(REDIS_PROVIDER_ID, context());
		expect(cluster.appliedNames()).toContain('NetworkPolicy/dep-redis');
	});
});
