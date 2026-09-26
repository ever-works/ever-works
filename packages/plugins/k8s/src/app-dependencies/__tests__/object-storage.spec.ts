/**
 * T21 — `app-dependencies/object-storage.provider.ts` (plan §4.9:618, §4.9:575-602, §4.9:604-611,
 * §4.9:620-628; spec FR-36/FR-37/FR-38/FR-40/FR-41/FR-43/FR-47/FR-48, ACC-07-16; APW07-G01, APW07-G10).
 *
 * Every clause of T21's `**Test**` line has an `it` below: the StatefulSet with a 20 GiB claim; an init Job
 * that creates **every** declared bucket, with readiness requiring that Job's success inside ten minutes
 * (ACC-07-16); anonymous download only on `publicBuckets`; the service-account keys written to `dep-s3-app`;
 * the outputs; `deleteData: false` making zero API calls while `true` deletes the PVCs and re-lists to zero;
 * and `dep-s3` admitting same-namespace ingress only and being applied **before** the init Job and the
 * StatefulSet (APW07-G01).
 *
 * The `**Also**` clause of T21 (the shared `dep-<kind>` renderer's unit spec) lives in
 * `dependency-network-policy.spec.ts`, which walks all three service ports.
 *
 * **No network, ever.** `FakeDependencyCluster` (the shared `__tests__/dependency-cluster.fake.ts`)
 * implements the five-method `AppDependencyApi` port over an in-memory object list with
 * Server-Side-Apply merge semantics, and the provider's clock, its only wait and its poll interval are all
 * injected — so "the Job has not succeeded yet" costs one loop, not ten minutes.
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
import { APP_DEPENDENCY_PORTS, dependencyContainerSecurityContext, dependencyPodSecurityContext } from '../common';
import { isDigestPinned } from '../images';
import {
	OBJECT_STORAGE_JOB_CONTAINERS,
	OBJECT_STORAGE_OBJECT_NAMES,
	OBJECT_STORAGE_PORT,
	OBJECT_STORAGE_PROVIDER_DESCRIPTOR,
	OBJECT_STORAGE_PROVIDER_ID,
	OBJECT_STORAGE_REGION,
	OBJECT_STORAGE_ROOT_USER,
	ObjectStorageDependencyProvider,
	declaredBuckets,
	declaredPublicBuckets,
	generateAppCredentials,
	objectStorageOutputs,
	type ObjectStorageDependencyCluster
} from '../object-storage.provider';
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
		declared: { buckets: ['uploads', 'avatars'], publicBuckets: ['uploads'] },
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
function forbidden(message = 'forbidden: jobs is forbidden'): K8sPluginError {
	return new K8sPluginError('UNAUTHORIZED', message, { statusCode: 403 });
}

function objectStorageCluster(): FakeDependencyCluster {
	const cluster = new FakeDependencyCluster();
	cluster.seedStorageClass('standard');
	return cluster;
}

/** A provider over the fake, with a clock that never sleeps. */
function provider(cluster: FakeDependencyCluster, options: Json = {}): ObjectStorageDependencyProvider {
	return new ObjectStorageDependencyProvider(cluster, {
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

function storedSecret(cluster: FakeDependencyCluster, name: string): Json | undefined {
	return cluster.stored('Secret').find((entry) => entry.metadata?.name === name);
}

/** One key of one stored Secret, decoded — how a spec checks what the cluster really holds. */
function storedValue(cluster: FakeDependencyCluster, name: string, key: string): string {
	return Buffer.from(String(storedSecret(cluster, name)?.data?.[key] ?? ''), 'base64').toString('utf8');
}

/** The init Job the provider applied, with its two container lists. */
function initJob(cluster: FakeDependencyCluster): Json {
	return cluster.appliedOf('Job')[0];
}

function jobContainers(cluster: FakeDependencyCluster): Json[] {
	const job = initJob(cluster);
	return [...(job.spec.template.spec.initContainers ?? []), ...(job.spec.template.spec.containers ?? [])];
}

function jobContainer(cluster: FakeDependencyCluster, name: string): Json {
	const container = jobContainers(cluster).find((entry) => entry.name === name);
	expect(container, `the init Job has no '${name}' container`).toBeDefined();
	return container as Json;
}

/* ------------------------------------------------------------------------- *
 * FR-36/FR-37: the server
 * ------------------------------------------------------------------------- */

describe('T21 — the StatefulSet (FR-36, FR-37, ACC-07-16)', () => {
	it('provisions a single-replica server with a 20 GiB claim and the pinned S3 images', async () => {
		const cluster = objectStorageCluster();

		const outcome = await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());
		expect(outcome.state).toBe('ready');

		const statefulSet = cluster.appliedOf('StatefulSet')[0];
		expect(statefulSet.metadata.name).toBe(OBJECT_STORAGE_OBJECT_NAMES.statefulSet);
		expect(statefulSet.metadata.namespace).toBe(NAMESPACE);
		expect(statefulSet.spec.replicas).toBe(1);
		expect(statefulSet.spec.serviceName).toBe(OBJECT_STORAGE_OBJECT_NAMES.service);
		// FR-37: object storage's volume default is 20 GiB, and this context declares no size of its own.
		expect(statefulSet.spec.volumeClaimTemplates).toHaveLength(1);
		expect(statefulSet.spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe('20Gi');
		expect(statefulSet.spec.template.spec.containers[0].volumeMounts).toEqual([
			{ name: 'data', mountPath: '/data' }
		]);

		const container = statefulSet.spec.template.spec.containers[0];
		expect(container.args).toEqual(['server', '/data']);
		expect(container.readinessProbe.httpGet).toEqual({ path: '/minio/health/ready', port: OBJECT_STORAGE_PORT });
		expect(container.env).toEqual(
			expect.arrayContaining([
				{
					name: 'MINIO_ROOT_USER',
					valueFrom: { secretKeyRef: { name: 'dep-s3', key: 'rootUser' } }
				},
				{
					name: 'MINIO_ROOT_PASSWORD',
					valueFrom: { secretKeyRef: { name: 'dep-s3', key: 'rootPassword' } }
				}
			])
		);
		// Every image is digest-pinned: the server here, and the `mc` the init Job runs below.
		expect(isDigestPinned(container.image)).toBe(true);
		expect(container.image).toContain('quay.io/minio/minio@sha256:');
		expect(isDigestPinned(jobContainer(cluster, OBJECT_STORAGE_JOB_CONTAINERS.buckets).image)).toBe(true);
		expect(jobContainer(cluster, OBJECT_STORAGE_JOB_CONTAINERS.buckets).image).toContain(
			'quay.io/minio/mc@sha256:'
		);
	});

	it("honours the owner's declared size and the plugin's default size setting (FR-37)", async () => {
		const declared = objectStorageCluster();
		await provider(declared).provision(OBJECT_STORAGE_PROVIDER_ID, context({ sizeGiB: 30 }));
		expect(declared.appliedOf('StatefulSet')[0].spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe(
			'30Gi'
		);

		const fromSettings = objectStorageCluster();
		await provider(fromSettings).provision(
			OBJECT_STORAGE_PROVIDER_ID,
			context({ sizeGiB: undefined, settings: { appDependencySizes: { objectStorage: 25 } } })
		);
		expect(
			fromSettings.appliedOf('StatefulSet')[0].spec.volumeClaimTemplates[0].spec.resources.requests.storage
		).toBe('25Gi');
	});

	it('labels the claim retain, so the buckets survive the workload (R-15)', async () => {
		const cluster = objectStorageCluster();

		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		const claim = cluster.appliedOf('StatefulSet')[0].spec.volumeClaimTemplates[0];
		expect(claim.metadata.labels).toEqual({
			[APP_LABEL_MANAGED_BY]: APP_MANAGED_BY,
			[APP_LABEL_PART_OF]: WORK_SLUG,
			[APP_LABEL_WORK_ID]: WORK_ID,
			[APP_LABEL_KIND]: APP_LABEL_KIND_APP,
			[APP_DEPENDENCY_POLICY_LABEL]: 's3',
			[APP_LABEL_RETAIN]: 'true'
		});
		// The PVC the cluster created from that template carries them, which is what the teardown finds.
		expect(cluster.stored('PersistentVolumeClaim')[0].metadata.labels).toEqual(claim.metadata.labels);
		expect(cluster.stored('PersistentVolumeClaim')[0].metadata.name).toBe('dep-s3-data-0');
	});

	it('renders one ClusterIP Service on 9000 — never a LoadBalancer or a NodePort (plan §4.9:580)', async () => {
		const cluster = objectStorageCluster();

		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		const services = cluster.appliedOf('Service');
		expect(services).toHaveLength(1);
		expect(services[0].metadata.name).toBe(OBJECT_STORAGE_OBJECT_NAMES.service);
		expect(services[0].spec.type).toBe('ClusterIP');
		expect(services[0].spec.selector).toEqual({ [APP_DEPENDENCY_POLICY_LABEL]: 's3' });
		expect(services[0].spec.ports).toEqual([
			{ name: 's3', port: OBJECT_STORAGE_PORT, targetPort: OBJECT_STORAGE_PORT, protocol: 'TCP' }
		]);
	});

	it('runs every container non-root, with drop ALL and a RuntimeDefault seccomp profile', async () => {
		const cluster = objectStorageCluster();

		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		const pod = cluster.appliedOf('StatefulSet')[0].spec.template.spec;
		expect(pod.securityContext).toEqual(
			dependencyPodSecurityContext({ runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 })
		);
		expect(pod.securityContext.runAsNonRoot).toBe(true);
		expect(cluster.appliedOf('StatefulSet')[0].spec.template.spec.containers[0].securityContext).toEqual(
			dependencyContainerSecurityContext()
		);

		const jobPod = initJob(cluster).spec.template.spec;
		expect(jobPod.securityContext.runAsNonRoot).toBe(true);
		expect(jobPod.securityContext.runAsUser).toBe(1000);
		for (const container of jobContainers(cluster)) {
			expect(container.securityContext).toEqual(dependencyContainerSecurityContext());
		}
	});
});

/* ------------------------------------------------------------------------- *
 * ACC-07-16: every declared bucket
 * ------------------------------------------------------------------------- */

describe('T21 — the init Job creates every declared bucket (ACC-07-16)', () => {
	it('creates every declared bucket, in the App spec’s order, in one mc invocation', async () => {
		const cluster = objectStorageCluster();

		await provider(cluster).provision(
			OBJECT_STORAGE_PROVIDER_ID,
			context({ declared: { buckets: ['uploads', 'avatars', 'reports'] } })
		);

		const container = jobContainer(cluster, OBJECT_STORAGE_JOB_CONTAINERS.buckets);
		expect(container.command).toEqual(['mc', 'mb', '--ignore-existing']);
		// Every declared bucket, and nothing else: this is ACC-07-16's "every declared bucket" in one line.
		expect(container.args).toEqual(['local/uploads', 'local/avatars', 'local/reports']);
		expect(container.imagePullPolicy).toBe('IfNotPresent');
		expect(container.env).toEqual(
			expect.arrayContaining([
				{
					name: 'MC_HOST_local',
					value: 'http://$(MINIO_ROOT_USER):$(MINIO_ROOT_PASSWORD)@dep-s3:9000'
				}
			])
		);
	});

	it('deduplicates a repeated declaration and never loses a bucket to it', async () => {
		const cluster = objectStorageCluster();

		await provider(cluster).provision(
			OBJECT_STORAGE_PROVIDER_ID,
			context({ declared: { buckets: ['uploads', 'uploads', 'avatars'] } })
		);

		expect(jobContainer(cluster, OBJECT_STORAGE_JOB_CONTAINERS.buckets).args).toEqual([
			'local/uploads',
			'local/avatars'
		]);
	});

	it('warns about a name the App spec could not have produced and still creates the rest', async () => {
		const cluster = objectStorageCluster();

		const outcome = await provider(cluster).provision(
			OBJECT_STORAGE_PROVIDER_ID,
			context({ declared: { buckets: ['uploads', 'Not A Bucket', 'avatars'] } })
		);

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		// Reported, never silently skipped: the card can say which declaration was left out.
		expect(outcome.warnings).toContain('bucketNameInvalid=Not A Bucket');
		expect(jobContainer(cluster, OBJECT_STORAGE_JOB_CONTAINERS.buckets).args).toEqual([
			'local/uploads',
			'local/avatars'
		]);
	});

	it('keeps the App spec’s ten-bucket ceiling and names what it dropped', async () => {
		const cluster = objectStorageCluster();
		const buckets = Array.from({ length: 12 }, (_, index) => `bucket-${index}`);

		const outcome = await provider(cluster).provision(
			OBJECT_STORAGE_PROVIDER_ID,
			context({ declared: { buckets } })
		);

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(jobContainer(cluster, OBJECT_STORAGE_JOB_CONTAINERS.buckets).args).toHaveLength(10);
		expect(outcome.warnings).toContain('bucketLimitExceeded=bucket-10');
		expect(outcome.warnings).toContain('bucketLimitExceeded=bucket-11');
	});

	it('declares no bucket container when nothing is declared, and still registers the service account', async () => {
		const cluster = objectStorageCluster();

		const outcome = await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context({ declared: {} }));

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(outcome.warnings).toContain('noBucketsDeclared');
		expect(jobContainers(cluster).map((entry) => entry.name)).toEqual([
			OBJECT_STORAGE_JOB_CONTAINERS.serviceAccount,
			OBJECT_STORAGE_JOB_CONTAINERS.policy
		]);
		// The endpoint and the keys are still handed over — an app may declare buckets later.
		expect(outcome.outputs?.endpoint).toBe(`http://dep-s3.${NAMESPACE}.svc.cluster.local:9000`);
		expect(outcome.outputs?.accessKeyId).toBeTruthy();
	});

	it('runs the Job to completion with a bounded retry budget and cleans it up afterwards', async () => {
		const cluster = objectStorageCluster();

		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		const job = initJob(cluster);
		expect(job.spec.backoffLimit).toBe(1);
		expect(job.spec.ttlSecondsAfterFinished).toBe(3_600);
		expect(job.spec.template.spec.restartPolicy).toBe('Never');
		// The service account is registered before the policy is attached, and both before the Job succeeds.
		expect(jobContainers(cluster).map((entry) => entry.name)).toEqual([
			OBJECT_STORAGE_JOB_CONTAINERS.buckets,
			'public-uploads',
			OBJECT_STORAGE_JOB_CONTAINERS.serviceAccount,
			OBJECT_STORAGE_JOB_CONTAINERS.policy
		]);
	});
});

/* ------------------------------------------------------------------------- *
 * anonymous download only on publicBuckets (plan §4.9:618)
 * ------------------------------------------------------------------------- */

describe('T21 — anonymous download only on publicBuckets', () => {
	it('sets anonymous download for exactly the declared public buckets', async () => {
		const cluster = objectStorageCluster();

		await provider(cluster).provision(
			OBJECT_STORAGE_PROVIDER_ID,
			context({ declared: { buckets: ['uploads', 'avatars', 'reports'], publicBuckets: ['uploads', 'reports'] } })
		);

		expect(jobContainer(cluster, 'public-uploads').command).toEqual(['mc', 'anonymous', 'set', 'download']);
		expect(jobContainer(cluster, 'public-uploads').args).toEqual(['local/uploads']);
		expect(jobContainer(cluster, 'public-reports').args).toEqual(['local/reports']);
		// `avatars` was declared but not made public — no container opens it.
		expect(jobContainers(cluster).map((entry) => entry.name)).not.toContain('public-avatars');
		expect(jobContainers(cluster).filter((entry) => entry.name.startsWith('public-'))).toHaveLength(2);
	});

	it('ignores a public bucket the App spec did not declare, and says so', async () => {
		const cluster = objectStorageCluster();

		const outcome = await provider(cluster).provision(
			OBJECT_STORAGE_PROVIDER_ID,
			context({ declared: { buckets: ['uploads'], publicBuckets: ['avatars'] } })
		);

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		// Opening a bucket nobody declared is the mistake this intersection prevents
		// (`public_bucket_undeclared`, APW-03 schema.md §11).
		expect(outcome.warnings).toContain('publicBucketUndeclared=avatars');
		expect(jobContainers(cluster).map((entry) => entry.name)).not.toContain('public-avatars');
	});

	it('opens nothing when publicBuckets is absent', async () => {
		const cluster = objectStorageCluster();

		await provider(cluster).provision(
			OBJECT_STORAGE_PROVIDER_ID,
			context({ declared: { buckets: ['uploads', 'avatars'] } })
		);

		expect(jobContainers(cluster).filter((entry) => entry.name.startsWith('public-'))).toEqual([]);
	});
});

/* ------------------------------------------------------------------------- *
 * FR-40/FR-47: the two credentials
 * ------------------------------------------------------------------------- */

describe('T21 — the service-account keys (FR-40, FR-47)', () => {
	it('writes both keys to dep-s3-app and registers them through secretKeyRef, never as literals', async () => {
		const cluster = objectStorageCluster();

		const outcome = await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());
		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;

		const accessKeyId = storedValue(cluster, 'dep-s3-app', 'accessKeyId');
		const secretAccessKey = storedValue(cluster, 'dep-s3-app', 'secretAccessKey');
		expect(accessKeyId).toBe(outcome.outputs?.accessKeyId);
		expect(secretAccessKey).toBe(outcome.outputs?.secretAccessKey);

		const userAdd = jobContainer(cluster, OBJECT_STORAGE_JOB_CONTAINERS.serviceAccount);
		expect(userAdd.command).toEqual(['mc', 'admin', 'user', 'add']);
		expect(userAdd.args).toEqual(['local', '$(APP_ACCESS_KEY)', '$(APP_SECRET_KEY)']);
		expect(userAdd.env).toEqual(
			expect.arrayContaining([
				{ name: 'APP_ACCESS_KEY', valueFrom: { secretKeyRef: { name: 'dep-s3-app', key: 'accessKeyId' } } },
				{
					name: 'APP_SECRET_KEY',
					valueFrom: { secretKeyRef: { name: 'dep-s3-app', key: 'secretAccessKey' } }
				}
			])
		);
		expect(jobContainer(cluster, OBJECT_STORAGE_JOB_CONTAINERS.policy).args).toEqual([
			'local',
			'readwrite',
			'--user',
			'$(APP_ACCESS_KEY)'
		]);

		// Neither key appears anywhere in the Job: the pair travels through the Secret, not the manifest.
		const job = JSON.stringify(initJob(cluster));
		expect(job).not.toContain(accessKeyId);
		expect(job).not.toContain(secretAccessKey);
	});

	it('puts no root credential in the Job manifest either', async () => {
		const cluster = objectStorageCluster();

		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		const rootPassword = storedValue(cluster, 'dep-s3', 'rootPassword');
		expect(rootPassword).toMatch(/^[0-9a-f]{32}$/);
		expect(storedValue(cluster, 'dep-s3', 'rootUser')).toBe(OBJECT_STORAGE_ROOT_USER);

		const job = JSON.stringify(initJob(cluster));
		expect(job).not.toContain(rootPassword);
		expect(job).toContain('$(MINIO_ROOT_PASSWORD)');
		// The alias URL is assembled by the kubelet from the two Secret-backed variables declared above it.
		expect(jobContainer(cluster, OBJECT_STORAGE_JOB_CONTAINERS.buckets).env[2]).toEqual({
			name: 'MC_HOST_local',
			value: 'http://$(MINIO_ROOT_USER):$(MINIO_ROOT_PASSWORD)@dep-s3:9000'
		});
	});

	it('generates keys inside MinIO’s documented bounds (access key ≤ 20, secret ≤ 40)', () => {
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const credentials = generateAppCredentials();
			expect(credentials.accessKeyId).toMatch(/^[0-9A-F]{20}$/);
			expect(credentials.secretAccessKey).toMatch(/^[0-9a-f]{40}$/);
		}
		expect(generateAppCredentials().accessKeyId).not.toBe(generateAppCredentials().accessKeyId);
	});

	it('never rotates the root password or the key pair on a re-provision (FR-47)', async () => {
		const cluster = objectStorageCluster();
		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());
		const first = {
			root: storedValue(cluster, 'dep-s3', 'rootPassword'),
			accessKeyId: storedValue(cluster, 'dep-s3-app', 'accessKeyId'),
			secretAccessKey: storedValue(cluster, 'dep-s3-app', 'secretAccessKey')
		};

		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		expect(storedValue(cluster, 'dep-s3', 'rootPassword')).toBe(first.root);
		expect(storedValue(cluster, 'dep-s3-app', 'accessKeyId')).toBe(first.accessKeyId);
		expect(storedValue(cluster, 'dep-s3-app', 'secretAccessKey')).toBe(first.secretAccessKey);
	});
});

/* ------------------------------------------------------------------------- *
 * ACC-07-16 / FR-41 / FR-43: readiness
 * ------------------------------------------------------------------------- */

describe('T21 — readiness (ACC-07-16, FR-41, FR-43)', () => {
	it('is not ready while the init Job has not succeeded, even though the server is ready', async () => {
		const cluster = objectStorageCluster();
		cluster.jobStatus = {};
		let polls = 0;

		const outcome = await provider(cluster, {
			maxPolls: 5,
			sleep: async () => {
				polls += 1;
			}
		}).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		// The StatefulSet reported a ready replica throughout — the Job is the half that gates the card.
		expect(cluster.readyReplicas).toBe(1);
		expect(polls).toBeGreaterThan(0);
		expect(outcome).toMatchObject({ state: 'pending' });
	});

	it('is ready once the Job succeeds, well inside the ten-minute deadline', async () => {
		const cluster = objectStorageCluster();
		cluster.jobStatus = {};
		const deadlineMs = 10 * 60_000;
		let now = 0;
		let polls = 0;

		const outcome = await provider(cluster, {
			now: () => now,
			pollIntervalMs: 5_000,
			sleep: async (millis: number) => {
				polls += 1;
				now += millis;
				// FR-41's ten minutes for object storage: this spec never lets the virtual clock pass it.
				expect(now).toBeLessThan(deadlineMs);
				if (polls === 3) cluster.jobStatus = { succeeded: 1 };
			}
		}).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		expect(outcome.state).toBe('ready');
		expect(polls).toBe(3);
		expect(now).toBe(15_000);
	});

	it('replaces a Job that failed and never succeeded instead of re-applying an immutable template', async () => {
		const cluster = objectStorageCluster();
		cluster.jobStatus = { failed: 1 };
		cluster.seed({
			apiVersion: 'batch/v1',
			kind: 'Job',
			metadata: { name: OBJECT_STORAGE_OBJECT_NAMES.initJob, namespace: NAMESPACE },
			spec: { backoffLimit: 1 },
			status: { failed: 1 }
		});

		const outcome = await provider(cluster, {
			maxPolls: 2,
			sleep: async () => undefined
		}).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		expect(cluster.deleted()).toContain(`Job/${OBJECT_STORAGE_OBJECT_NAMES.initJob}`);
		// The replacement is applied after the delete, and the retry is a retry rather than a dead end.
		expect(cluster.appliedNames()).toContain(`Job/${OBJECT_STORAGE_OBJECT_NAMES.initJob}`);
		expect(outcome.state).toBe('pending');
	});

	it('fails at the deadline, naming the init Job’s state, when the Job never succeeds', async () => {
		const cluster = objectStorageCluster();
		cluster.jobStatus = { failed: 1 };
		const controller = new AbortController();
		const deadlineMs = 10 * 60_000;
		let now = 0;
		let polls = 0;

		const outcome = await provider(cluster, {
			now: () => now,
			pollIntervalMs: 5_000,
			sleep: async (millis: number) => {
				polls += 1;
				now += millis;
				if (now >= deadlineMs) controller.abort();
			}
		}).provision(OBJECT_STORAGE_PROVIDER_ID, context({ signal: controller.signal }));

		expect(polls).toBe(120);
		expect(outcome).toMatchObject({
			state: 'failed',
			reason: 'deadlineExceeded',
			transient: false,
			detail: { initJob: 'failed', buckets: '2' }
		});
	});

	it('answers pending, never a tight loop, when a caller forgets to arm the deadline signal', async () => {
		const cluster = objectStorageCluster();
		cluster.jobStatus = {};
		let polls = 0;

		const outcome = await provider(cluster, {
			maxPolls: 4,
			sleep: async () => {
				polls += 1;
			}
		}).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		expect(polls).toBe(3);
		expect(outcome).toMatchObject({ state: 'pending', retryAfterMs: 1 });
	});

	it('fails clusterPermissionMissing when the credential may not create the server or the Job (APW07-G10)', async () => {
		const noStatefulSets = objectStorageCluster();
		noStatefulSets.applyFails.set('StatefulSet', forbidden('forbidden: statefulsets is forbidden'));

		expect(await provider(noStatefulSets).provision(OBJECT_STORAGE_PROVIDER_ID, context())).toMatchObject({
			state: 'failed',
			reason: 'clusterPermissionMissing',
			transient: false,
			detail: { resource: 'statefulsets', verb: 'create', namespace: NAMESPACE }
		});
		// The policy was already applied: the failure happens after the objects FR-38 needs.
		expect(noStatefulSets.appliedNames()[0]).toBe('NetworkPolicy/dep-s3');

		const noJobs = objectStorageCluster();
		noJobs.applyFails.set('Job', forbidden());

		expect(await provider(noJobs).provision(OBJECT_STORAGE_PROVIDER_ID, context())).toMatchObject({
			state: 'failed',
			reason: 'clusterPermissionMissing',
			transient: false,
			detail: { resource: 'jobs', verb: 'create', namespace: NAMESPACE }
		});
	});
});

/* ------------------------------------------------------------------------- *
 * FR-38 / APW07-G01: the policy goes first
 * ------------------------------------------------------------------------- */

describe('T21 — the dep-s3 NetworkPolicy (FR-38, APW07-G01)', () => {
	it('applies dep-s3 before the init Job and the StatefulSet, admitting same-namespace pods on 9000 only', async () => {
		const cluster = objectStorageCluster();

		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		const names = cluster.appliedNames();
		expect(names[0]).toBe('NetworkPolicy/dep-s3');
		expect(names.indexOf('NetworkPolicy/dep-s3')).toBeLessThan(names.indexOf('StatefulSet/dep-s3'));
		expect(names.indexOf('NetworkPolicy/dep-s3')).toBeLessThan(names.indexOf('Job/dep-s3-init'));

		const policy = cluster.appliedOf('NetworkPolicy')[0];
		// The object kind is `s3`, not `objectStorage` (plan §4.9:618), so the name the reachability check
		// looks for is the one the teardown's label scan uses.
		expect(policy.metadata.name).toBe(dependencyNetworkPolicyName('s3'));
		expect(policy.spec.podSelector).toEqual({ matchLabels: { [APP_DEPENDENCY_POLICY_LABEL]: 's3' } });
		expect(policy.spec.policyTypes).toEqual(['Ingress']);
		expect(policy.spec.ingress).toEqual([
			{ from: [{ podSelector: {} }], ports: [{ protocol: 'TCP', port: APP_DEPENDENCY_PORTS.objectStorage }] }
		]);
		expect(cluster.appliedOf('NetworkPolicy')).toHaveLength(1);
	});

	it('draws the policy with isolation off too — the context carries no isolation switch (APW07-G01)', async () => {
		const strict = objectStorageCluster();
		const switchedOff = objectStorageCluster();

		await provider(strict).provision(OBJECT_STORAGE_PROVIDER_ID, context());
		await provider(switchedOff).provision(
			OBJECT_STORAGE_PROVIDER_ID,
			context({ isolation: false, appWorkIsolation: false })
		);

		expect(switchedOff.appliedOf('NetworkPolicy')[0]).toEqual(strict.appliedOf('NetworkPolicy')[0]);
		expect(switchedOff.appliedNames()[0]).toBe('NetworkPolicy/dep-s3');
	});
});

/* ------------------------------------------------------------------------- *
 * FR-40/FR-42: the outputs
 * ------------------------------------------------------------------------- */

describe('T21 — the outputs (FR-40, FR-42)', () => {
	it('emits endpoint, region, both keys and one bucket.<name> per declared bucket', async () => {
		const cluster = objectStorageCluster();

		const outcome = await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());
		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;

		expect(outcome.outputs).toEqual({
			endpoint: `http://dep-s3.${NAMESPACE}.svc.cluster.local:9000`,
			region: OBJECT_STORAGE_REGION,
			accessKeyId: storedValue(cluster, 'dep-s3-app', 'accessKeyId'),
			secretAccessKey: storedValue(cluster, 'dep-s3-app', 'secretAccessKey'),
			'bucket.uploads': 'uploads',
			'bucket.avatars': 'avatars'
		});
		expect(OBJECT_STORAGE_REGION).toBe('us-east-1');
		// No root credential, and no fourth key: FR-40's names are the whole set.
		expect(Object.keys(outcome.outputs ?? {}).sort()).toEqual([
			'accessKeyId',
			'bucket.avatars',
			'bucket.uploads',
			'endpoint',
			'region',
			'secretAccessKey'
		]);
		expect(outcome.resourceRefs?.buckets).toEqual(['uploads', 'avatars']);
		expect(outcome.resourceRefs?.objects).toEqual([
			{ kind: 'NetworkPolicy', name: 'dep-s3' },
			{ kind: 'Secret', name: 'dep-s3' },
			{ kind: 'Secret', name: 'dep-s3-app' },
			{ kind: 'StatefulSet', name: 'dep-s3' },
			{ kind: 'Service', name: 'dep-s3' },
			{ kind: 'Job', name: 'dep-s3-init' }
		]);
	});

	it('reads the keys back out of dep-s3-app on a refresh (FR-42)', async () => {
		const cluster = objectStorageCluster();
		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		// A key pair replaced by hand is exactly what a `refresh` must see.
		cluster.seed({
			apiVersion: 'v1',
			kind: 'Secret',
			metadata: { name: OBJECT_STORAGE_OBJECT_NAMES.appSecret, namespace: NAMESPACE },
			data: {
				accessKeyId: Buffer.from('ROTATEDKEY', 'utf8').toString('base64'),
				secretAccessKey: Buffer.from('rotated-secret', 'utf8').toString('base64')
			}
		});

		const outputs = await provider(cluster).getOutputs(OBJECT_STORAGE_PROVIDER_ID, context());

		expect(outputs.accessKeyId).toBe('ROTATEDKEY');
		expect(outputs.secretAccessKey).toBe('rotated-secret');
		expect(outputs.endpoint).toBe(`http://dep-s3.${NAMESPACE}.svc.cluster.local:9000`);
	});

	it('throws rather than answering an empty output set when dep-s3-app is gone (plan §9.2:955)', async () => {
		const cluster = objectStorageCluster();

		await expect(provider(cluster).getOutputs(OBJECT_STORAGE_PROVIDER_ID, context())).rejects.toThrow(/dep-s3-app/);
	});

	it('answers with a typed error for a provider id it does not serve', async () => {
		const cluster = objectStorageCluster();

		await expect(provider(cluster).getOutputs('s3-external', context())).rejects.toThrow(/s3-external/);
		expect(await provider(cluster).provision('s3-external', context())).toMatchObject({
			state: 'failed',
			reason: 'providerNotSupported'
		});
		expect(await provider(cluster).supports('redis', 'your-cluster')).toEqual({
			supported: false,
			reason: 'providerNotSupported'
		});
	});
});

/* ------------------------------------------------------------------------- *
 * FR-48 / plan §4.9:624-628: backup state and deprovision
 * ------------------------------------------------------------------------- */

describe('T21 — backup state and deprovision (FR-48, plan §4.9:624-628)', () => {
	it('reports backup state none without touching the cluster (FR-48)', async () => {
		const cluster = objectStorageCluster();
		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());
		const before = cluster.calls.length;

		expect(await provider(cluster).backupStatus(OBJECT_STORAGE_PROVIDER_ID, context())).toEqual({ state: 'none' });
		expect(cluster.calls.length).toBe(before);
	});

	it('makes no cluster call at all when data is kept and the workload is not stopped', async () => {
		const cluster = objectStorageCluster();
		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());
		const before = cluster.calls.length;

		const outcome = await provider(cluster).deprovision(OBJECT_STORAGE_PROVIDER_ID, context(), {
			deleteData: false
		});

		expect(outcome).toEqual({ state: 'released' });
		expect(cluster.calls.length).toBe(before);
	});

	it('scales the server to zero for stopWorkloads and touches nothing else — buckets included', async () => {
		const cluster = objectStorageCluster();
		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		const outcome = await provider(cluster).deprovision(OBJECT_STORAGE_PROVIDER_ID, context(), {
			deleteData: false,
			stopWorkloads: true
		});

		expect(outcome).toEqual({ state: 'released' });
		expect(cluster.applied().at(-1)).toMatchObject({ kind: 'StatefulSet', spec: { replicas: 0 } });
		// R-15: the volume holds the buckets, and nothing but the workload was touched.
		expect(cluster.deleted()).toEqual([]);
		expect(cluster.stored('PersistentVolumeClaim')).toHaveLength(1);
		expect(
			cluster
				.stored('Secret')
				.map((entry) => entry.metadata?.name)
				.sort()
		).toEqual(['dep-s3', 'dep-s3-app']);
		expect(cluster.stored('NetworkPolicy').some((entry) => entry.metadata?.name === 'dep-s3')).toBe(true);
	});

	it('deletes the server, the PVCs, both Secrets, the Job and the policy, then re-lists to zero', async () => {
		const cluster = objectStorageCluster();
		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());

		const outcome = await provider(cluster).deprovision(OBJECT_STORAGE_PROVIDER_ID, context(), {
			deleteData: true
		});

		expect(outcome).toEqual({ state: 'deleted' });
		expect(cluster.deleted()).toEqual(
			expect.arrayContaining([
				'NetworkPolicy/dep-s3',
				'StatefulSet/dep-s3',
				'Secret/dep-s3',
				'Secret/dep-s3-app',
				'Service/dep-s3',
				'Job/dep-s3-init',
				'PersistentVolumeClaim/dep-s3-data-0'
			])
		);
		// The PVC is deleted explicitly, after the workload — never merely orphaned with its StatefulSet.
		expect(cluster.deleted()[cluster.deleted().length - 1]).toBe('PersistentVolumeClaim/dep-s3-data-0');
		// `deleted` means a fresh label scan found nothing: the last call of the volume's kind is a list.
		const pvcCalls = cluster.calls.filter((call) => call.kind === 'PersistentVolumeClaim');
		expect(pvcCalls.filter((call) => call.op === 'delete').length).toBeGreaterThan(0);
		expect(pvcCalls.at(-1)?.op).toBe('list');
		expect(cluster.stored('PersistentVolumeClaim')).toEqual([]);
		expect(cluster.stored('StatefulSet')).toEqual([]);
	});

	it('reports remaining when something survives the teardown', async () => {
		const cluster = objectStorageCluster();
		await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context());
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

		const outcome = await provider(cluster).deprovision(OBJECT_STORAGE_PROVIDER_ID, context(), {
			deleteData: true
		});

		expect(outcome.state).toBe('pending');
		expect(outcome.remaining?.objects).toEqual([{ kind: 'PersistentVolumeClaim', name: 'dep-s3-data-0' }]);
	});
});

/* ------------------------------------------------------------------------- *
 * R-10 / FR-60: the ephemeral variant
 * ------------------------------------------------------------------------- */

describe('T21 — the ephemeral variant (R-10, FR-60, ACC-07-31)', () => {
	it('uses emptyDir, renders no PVC and never probes for a storage class, and says so', async () => {
		const cluster = objectStorageCluster();

		const outcome = await provider(cluster).provision(OBJECT_STORAGE_PROVIDER_ID, context({ ephemeral: true }));

		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;
		expect(outcome.warnings).toContain('ephemeralNoPersistence');

		const statefulSet = cluster.appliedOf('StatefulSet')[0];
		expect(statefulSet.spec.volumeClaimTemplates).toBeUndefined();
		expect(statefulSet.spec.template.spec.volumes).toEqual([{ name: 'data', emptyDir: {} }]);
		expect(JSON.stringify(statefulSet)).not.toContain('PersistentVolumeClaim');
		expect(cluster.stored('PersistentVolumeClaim')).toEqual([]);
		expect(cluster.ops('list').filter((call) => call.kind === 'StorageClass')).toEqual([]);
		// The buckets still exist for the duration of the verification run.
		expect(jobContainer(cluster, OBJECT_STORAGE_JOB_CONTAINERS.buckets).args).toEqual([
			'local/uploads',
			'local/avatars'
		]);
	});
});

/* ------------------------------------------------------------------------- *
 * The declared block and the pure helpers
 * ------------------------------------------------------------------------- */

describe('T21 — the declared block, read defensively', () => {
	it('reads only the App spec’s own name shape and reports everything it drops', () => {
		const warnings: string[] = [];

		expect(declaredBuckets(context({ declared: { buckets: ['a', 'b-1', 'c.d'] } }), warnings)).toEqual([
			'a',
			'b-1'
		]);
		expect(warnings).toEqual(['bucketNameInvalid=c.d']);
		// Not an array at all is "nothing declared", never a crash.
		expect(declaredBuckets(context({ declared: { buckets: 'uploads' } }), warnings)).toEqual([]);
		expect(warnings).toEqual(['bucketNameInvalid=c.d']);
	});

	it('intersects publicBuckets with the buckets that will exist', () => {
		const warnings: string[] = [];

		expect(
			declaredPublicBuckets(
				context({ declared: { publicBuckets: ['uploads', 'nope', 'uploads'] } }),
				['uploads'],
				warnings
			)
		).toEqual(['uploads']);
		expect(warnings).toEqual(['publicBucketUndeclared=nope']);
		expect(declaredPublicBuckets(context({ declared: {} }), ['uploads'], warnings)).toEqual([]);
	});

	it('builds the endpoint from the Service DNS name and the plan’s fixed port and region', () => {
		const cluster: ObjectStorageDependencyCluster = {
			kubeconfig: KUBECONFIG,
			namespace: NAMESPACE,
			workSlug: WORK_SLUG
		};

		expect(objectStorageOutputs(cluster, { accessKeyId: 'AK', secretAccessKey: 'SK' }, ['uploads'])).toEqual({
			endpoint: `http://dep-s3.${NAMESPACE}.svc.cluster.local:9000`,
			region: 'us-east-1',
			accessKeyId: 'AK',
			secretAccessKey: 'SK',
			'bucket.uploads': 'uploads'
		});
	});
});

/* ------------------------------------------------------------------------- *
 * plan §4.9:570 / tasks.md:319: the plugin's own wiring
 * ------------------------------------------------------------------------- */

describe('T21 — the k8s plugin publishes and delegates (plan §4.9:570, tasks.md:319)', () => {
	it('publishes all three descriptors, each with the plan’s preference and target', () => {
		const plugin = new KubernetesPlugin();

		expect(plugin.dependencyProviders.map((entry) => entry.id)).toEqual([
			'k8s-inline-postgres',
			'k8s-inline-redis',
			'k8s-inline-minio'
		]);
		expect(plugin.dependencyProviders).toContainEqual(OBJECT_STORAGE_PROVIDER_DESCRIPTOR);
		expect(OBJECT_STORAGE_PROVIDER_DESCRIPTOR).toEqual({
			id: 'k8s-inline-minio',
			kind: 'objectStorage',
			targets: ['your-cluster'],
			label: 'In your cluster · single instance',
			preference: 10,
			backupPolicy: 'none'
		});
		// All three are `your-cluster` only (R-5) and all three beat `s3-external`'s 20. Postgres is the one
		// with a backup policy that is not `none` — its operator path takes backups (plan §4.9:615).
		for (const descriptor of plugin.dependencyProviders) {
			expect(descriptor.targets).toEqual(['your-cluster']);
			expect(descriptor.preference).toBe(10);
		}
		expect(plugin.dependencyProviders.map((entry) => entry.backupPolicy)).toEqual(['operator', 'none', 'none']);
	});

	it('answers supports for objectStorage on your-cluster and never on the managed tier', async () => {
		const plugin = pluginOver(objectStorageCluster());

		expect(await plugin.supports('objectStorage', 'your-cluster', context())).toEqual({
			supported: true,
			providerId: OBJECT_STORAGE_PROVIDER_ID
		});
		// R-5: the managed tier's `managed-object-storage` is APW-10's, never this plugin's.
		expect(await plugin.supports('objectStorage', 'ever-works-apps', context())).toEqual({
			supported: false,
			reason: 'providerNotSupported'
		});
		expect(await plugin.supports('smtp', 'your-cluster', context())).toEqual({
			supported: false,
			reason: 'providerNotSupported'
		});
	});

	it('delegates provision, getOutputs, deprovision and backupStatus to its own provider', async () => {
		const cluster = objectStorageCluster();
		const plugin = pluginOver(cluster);

		const outcome = await plugin.provision(OBJECT_STORAGE_PROVIDER_ID, context());
		expect(outcome.state).toBe('ready');
		// Going through the plugin, the `dep-s3` policy is still applied first.
		expect(cluster.appliedNames()[0]).toBe('NetworkPolicy/dep-s3');

		expect(await plugin.getOutputs(OBJECT_STORAGE_PROVIDER_ID, context())).toMatchObject({
			region: 'us-east-1'
		});
		expect(await plugin.backupStatus(OBJECT_STORAGE_PROVIDER_ID, context())).toEqual({ state: 'none' });
		expect(await plugin.deprovision(OBJECT_STORAGE_PROVIDER_ID, context(), { deleteData: false })).toEqual({
			state: 'released'
		});
	});
});
