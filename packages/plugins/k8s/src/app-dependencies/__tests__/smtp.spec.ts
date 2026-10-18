/**
 * Lane aw-env-smtp (GAP-22) — `app-dependencies/smtp.provider.ts`, the `smtp` dependency.
 *
 * Two modes, both pinned here: the default in-namespace Mailpit sink (objects, order, Pod Security
 * `restricted`, the pinned image, reachability, readiness, the six outputs, a stable password) and the
 * bring-your-own server, which provisions nothing and answers the owner's values as the outputs. Plus
 * deprovision, the backup state and the plugin's own registration.
 *
 * **No network, ever** — the shared `FakeDependencyCluster`, and an injected clock that never sleeps.
 */
import { describe, expect, it } from 'vitest';

import type { AppDependencyContext } from '@ever-works/plugin';

import { K8sPluginError } from '../../errors';
import { KubernetesPlugin } from '../../k8s.plugin';
import { APP_DEPENDENCY_POLICY_LABEL } from '../../app/app-network-policy.renderer';
import { APP_LABEL_PART_OF } from '../../app/app-names';
import { MAILPIT_IMAGE_DIGEST, isDigestPinned } from '../images';
import {
	SMTP_EXTERNAL_VERSION,
	SMTP_MAILPIT_USER,
	SMTP_OBJECT_NAMES,
	SMTP_PORT,
	SMTP_PROVIDER_DESCRIPTOR,
	SMTP_PROVIDER_ID,
	SMTP_UI_PORT,
	SmtpDependencyProvider,
	declaredFrom,
	externalSmtpServer,
	mailpitContainerEnv
} from '../smtp.provider';
import { FakeDependencyCluster, type Json } from './dependency-cluster.fake';
import type { KubernetesApiService } from '../../k8s-api.service';

const WORK_ID = '5a07fa3f-367a-444e-9d1e-311d03cc1327';
const WORK_SLUG = 'app-fixture-hello';
const NAMESPACE = 'ewapp-app-fixture-hello-5a07fa3f';
const KUBECONFIG = 'managed-kubeconfig';

/**
 * `APP_DEPENDENCY_OUTPUTS.smtp`'s names (`@ever-works/contracts`, FR-40) — restated because the plugin
 * does not depend on the contracts package (`common.ts` records why); `app-env.resolver.ts` reads these.
 */
const SMTP_OUTPUT_NAMES = ['from', 'host', 'password', 'port', 'secure', 'user'];

function context(overrides: Json = {}): AppDependencyContext {
	return {
		workId: WORK_ID,
		appName: WORK_SLUG,
		target: 'your-cluster',
		declared: { required: true },
		cluster: {
			kubeconfig: KUBECONFIG,
			context: null,
			namespace: NAMESPACE,
			appLabels: { [APP_LABEL_PART_OF]: WORK_SLUG }
		},
		settings: {},
		signal: new AbortController().signal,
		...overrides
	} as unknown as AppDependencyContext;
}

function provider(cluster: FakeDependencyCluster, options: Json = {}): SmtpDependencyProvider {
	return new SmtpDependencyProvider(cluster, {
		now: () => 0,
		sleep: async () => undefined,
		pollIntervalMs: 1,
		...options
	});
}

function storedPassword(cluster: FakeDependencyCluster): string {
	const secret = cluster.stored('Secret').find((entry) => entry.metadata?.name === SMTP_OBJECT_NAMES.secret);
	return Buffer.from(String(secret?.data?.password ?? ''), 'base64').toString('utf8');
}

describe('k8s-inline-mailpit — the descriptor', () => {
	it('is the smtp provider for your-cluster, behind every provider that really delivers mail', () => {
		expect(SMTP_PROVIDER_DESCRIPTOR).toMatchObject({
			id: 'k8s-inline-mailpit',
			kind: 'smtp',
			targets: ['your-cluster'],
			preference: 30,
			backupPolicy: 'none'
		});
		// Never waits for the owner: an empty configuration IS the default.
		expect(SMTP_PROVIDER_DESCRIPTOR.awaitingConfig).toBeUndefined();
		const schema = SMTP_PROVIDER_DESCRIPTOR.promptSchema as Json;
		expect(Object.keys(schema.properties)).toEqual(['host', 'port', 'user', 'password', 'from', 'secure']);
		expect(schema.properties.password['x-secret']).toBe(true);
		expect(schema.required).toBeUndefined();
	});

	it('supports (smtp, your-cluster) and nothing else', async () => {
		const smtp = provider(new FakeDependencyCluster());
		expect(await smtp.supports('smtp', 'your-cluster')).toEqual({ supported: true, providerId: SMTP_PROVIDER_ID });
		expect(await smtp.supports('smtp', 'ever-works-apps')).toMatchObject({ supported: false });
		expect(await smtp.supports('redis', 'your-cluster')).toMatchObject({ supported: false });
	});
});

describe('k8s-inline-mailpit — the in-namespace mail sink', () => {
	it('applies policy, Secret, Service and Deployment, in that order, and answers ready with the six outputs', async () => {
		const cluster = new FakeDependencyCluster();
		const outcome = await provider(cluster).provision(SMTP_PROVIDER_ID, context());

		expect(cluster.appliedNames()).toEqual([
			'NetworkPolicy/dep-smtp',
			'Secret/dep-smtp',
			'Service/dep-smtp',
			'Deployment/dep-smtp'
		]);
		expect(outcome.state).toBe('ready');
		if (outcome.state !== 'ready') return;

		expect(Object.keys(outcome.outputs).sort()).toEqual(SMTP_OUTPUT_NAMES);
		expect(outcome.outputs).toMatchObject({
			host: `dep-smtp.${NAMESPACE}.svc.cluster.local`,
			port: String(SMTP_PORT),
			user: SMTP_MAILPIT_USER,
			from: 'no-reply@app-fixture-hello.invalid',
			secure: 'false'
		});
		expect(outcome.outputs.password).toMatch(/^[0-9a-f]{32}$/);
		expect(outcome.outputs.password).toBe(storedPassword(cluster));
		expect(outcome.resourceRefs.objects.map((object) => `${object.kind}/${object.name}`)).toEqual([
			'NetworkPolicy/dep-smtp',
			'Secret/dep-smtp',
			'Service/dep-smtp',
			'Deployment/dep-smtp'
		]);
	});

	it('keeps the password across re-provisions (FR-47 — no implicit rotation)', async () => {
		const cluster = new FakeDependencyCluster();
		const first = await provider(cluster).provision(SMTP_PROVIDER_ID, context());
		const second = await provider(cluster).provision(SMTP_PROVIDER_ID, context());
		expect(first.state === 'ready' && second.state === 'ready').toBe(true);
		if (first.state !== 'ready' || second.state !== 'ready') return;
		expect(second.outputs.password).toBe(first.outputs.password);
	});

	it('admits same-namespace pods on the SMTP and UI ports only (FR-38)', async () => {
		const cluster = new FakeDependencyCluster();
		await provider(cluster).provision(SMTP_PROVIDER_ID, context());

		const [policy] = cluster.appliedOf('NetworkPolicy');
		expect(policy.metadata.labels[APP_DEPENDENCY_POLICY_LABEL]).toBe('smtp');
		expect(policy.spec.podSelector).toEqual({ matchLabels: { [APP_DEPENDENCY_POLICY_LABEL]: 'smtp' } });
		expect(policy.spec.policyTypes).toEqual(['Ingress']);
		expect(policy.spec.ingress).toEqual([
			{
				from: [{ podSelector: {} }],
				ports: [
					{ protocol: 'TCP', port: SMTP_PORT },
					{ protocol: 'TCP', port: SMTP_UI_PORT }
				]
			}
		]);

		const [service] = cluster.appliedOf('Service');
		expect(service.spec.type).toBe('ClusterIP');
		expect(service.spec.ports.map((port: Json) => port.port)).toEqual([SMTP_PORT, SMTP_UI_PORT]);
	});

	it('runs a pinned image under Pod Security restricted, with small resources and no relay', async () => {
		const cluster = new FakeDependencyCluster();
		await provider(cluster).provision(SMTP_PROVIDER_ID, context());

		const [deployment] = cluster.appliedOf('Deployment');
		const pod = deployment.spec.template.spec;
		const [container] = pod.containers;

		expect(isDigestPinned(container.image)).toBe(true);
		expect(container.image).toBe(`docker.io/axllent/mailpit@${MAILPIT_IMAGE_DIGEST}`);
		expect(deployment.spec.replicas).toBe(1);
		expect(deployment.spec.strategy).toEqual({ type: 'Recreate' });
		expect(pod.automountServiceAccountToken).toBe(false);
		expect(pod.securityContext).toEqual({
			runAsNonRoot: true,
			seccompProfile: { type: 'RuntimeDefault' },
			runAsUser: 1000,
			runAsGroup: 1000,
			fsGroup: 1000
		});
		expect(container.securityContext).toEqual({
			allowPrivilegeEscalation: false,
			capabilities: { drop: ['ALL'] },
			readOnlyRootFilesystem: true
		});
		expect(container.resources).toEqual({
			requests: { cpu: '10m', memory: '32Mi' },
			limits: { cpu: '200m', memory: '128Mi' }
		});
		// Only emptyDirs: no PVC is ever drawn for a sink.
		expect(pod.volumes.every((volume: Json) => 'emptyDir' in volume)).toBe(true);
		expect(cluster.stored('PersistentVolumeClaim')).toEqual([]);

		const env = Object.fromEntries(mailpitContainerEnv().map((entry) => [entry.name, entry.value]));
		expect(container.env).toEqual(mailpitContainerEnv());
		expect(env.MP_SMTP_AUTH_ACCEPT_ANY).toBe('true');
		expect(env.MP_SMTP_AUTH_ALLOW_INSECURE).toBe('true');
		expect(env.MP_DISABLE_VERSION_CHECK).toBe('true');
		// No outbound path is configured: no relay, no webhook.
		expect(Object.keys(env).some((name) => name.startsWith('MP_SMTP_RELAY') || name === 'MP_WEBHOOK_URL')).toBe(
			false
		);
		// No credential reaches the manifest.
		expect(JSON.stringify(deployment)).not.toContain(storedPassword(cluster));
		expect(container.readinessProbe.httpGet).toEqual({ path: '/readyz', port: SMTP_UI_PORT });
	});

	it('honours an admin image override only when it is digest-pinned', async () => {
		const cluster = new FakeDependencyCluster();
		const pinned = `registry.example/mailpit@sha256:${'b'.repeat(64)}`;
		await provider(cluster).provision(
			SMTP_PROVIDER_ID,
			context({ settings: { appDependencyImages: { smtp: pinned } } })
		);
		expect(cluster.appliedOf('Deployment')[0].spec.template.spec.containers[0].image).toBe(pinned);

		const tagged = new FakeDependencyCluster();
		await provider(tagged).provision(
			SMTP_PROVIDER_ID,
			context({ settings: { appDependencyImages: { smtp: 'axllent/mailpit:latest' } } })
		);
		expect(tagged.appliedOf('Deployment')[0].spec.template.spec.containers[0].image).toContain(
			MAILPIT_IMAGE_DIGEST
		);
	});

	it('answers pending while the sink is not ready, and deadlineExceeded once the signal aborts', async () => {
		const cluster = new FakeDependencyCluster();
		cluster.readyReplicas = 0;
		const pending = await provider(cluster, { maxPolls: 3 }).provision(SMTP_PROVIDER_ID, context());
		expect(pending).toMatchObject({ state: 'pending', retryAfterMs: 1 });

		const controller = new AbortController();
		controller.abort();
		const aborted = await provider(cluster).provision(SMTP_PROVIDER_ID, context({ signal: controller.signal }));
		expect(aborted).toMatchObject({ state: 'failed', reason: 'deadlineExceeded', transient: false });
	});

	it('fails definitely on a refused apply, and retryably without a cluster', async () => {
		const cluster = new FakeDependencyCluster();
		cluster.applyFails.set('Deployment', new K8sPluginError('UNAUTHORIZED', 'forbidden', { statusCode: 403 }));
		expect(await provider(cluster).provision(SMTP_PROVIDER_ID, context())).toMatchObject({
			state: 'failed',
			reason: 'clusterPermissionMissing',
			transient: false
		});

		expect(
			await provider(new FakeDependencyCluster()).provision(SMTP_PROVIDER_ID, context({ cluster: undefined }))
		).toMatchObject({
			state: 'failed',
			reason: 'clusterUnreachable',
			transient: true
		});
		expect(await provider(cluster).provision('k8s-inline-redis', context())).toMatchObject({
			state: 'failed',
			reason: 'providerNotSupported'
		});
	});

	it('uses the App spec’s own from-address when it declares one', () => {
		const cluster = { kubeconfig: KUBECONFIG, namespace: NAMESPACE, workSlug: 'My App!' };
		expect(declaredFrom(context({ declared: { from: 'hello@example.com' } }), cluster)).toBe('hello@example.com');
		expect(declaredFrom(context(), cluster)).toBe('no-reply@my-app.invalid');
	});

	it('re-reads its outputs from the cluster', async () => {
		const cluster = new FakeDependencyCluster();
		const outcome = await provider(cluster).provision(SMTP_PROVIDER_ID, context());
		const outputs = await provider(cluster).getOutputs(SMTP_PROVIDER_ID, context());
		expect(outputs).toEqual((outcome as { outputs: Json }).outputs);

		await expect(provider(new FakeDependencyCluster()).getOutputs(SMTP_PROVIDER_ID, context())).rejects.toThrow(
			/clusterUnreachable/
		);
	});

	it('marks an ephemeral (verification) sink', async () => {
		const outcome = await provider(new FakeDependencyCluster()).provision(
			SMTP_PROVIDER_ID,
			context({ ephemeral: true })
		);
		expect(outcome).toMatchObject({ state: 'ready', warnings: ['ephemeralNoPersistence'] });
	});
});

describe('k8s-inline-mailpit — bring your own SMTP server', () => {
	const config = {
		host: 'smtp.example.com',
		port: '587',
		user: 'mailer@example.com',
		password: 'byo-p4ss',
		from: 'App <app@example.com>'
	};

	it('answers the owner’s values as the outputs and provisions nothing', async () => {
		const cluster = new FakeDependencyCluster();
		const outcome = await provider(cluster).provision(SMTP_PROVIDER_ID, context({ config }));

		expect(outcome).toEqual({
			state: 'ready',
			outputs: {
				host: 'smtp.example.com',
				port: '587',
				user: 'mailer@example.com',
				password: 'byo-p4ss',
				from: 'App <app@example.com>',
				secure: 'false'
			},
			actualVersion: SMTP_EXTERNAL_VERSION,
			resourceRefs: { objects: [] },
			warnings: ['externalSmtp']
		});
		expect(cluster.ops('apply')).toEqual([]);
		expect(Object.keys((outcome as { outputs: Json }).outputs).sort()).toEqual(SMTP_OUTPUT_NAMES);
	});

	it('needs no cluster at all', async () => {
		expect(
			await provider(new FakeDependencyCluster()).provision(
				SMTP_PROVIDER_ID,
				context({ config, cluster: undefined })
			)
		).toMatchObject({ state: 'ready' });
	});

	it('stops a sink this row ran before (scale to 0, nothing deleted)', async () => {
		const cluster = new FakeDependencyCluster();
		await provider(cluster).provision(SMTP_PROVIDER_ID, context());
		const before = cluster.ops('apply').length;

		await provider(cluster).provision(SMTP_PROVIDER_ID, context({ config }));
		const applies = cluster.ops('apply').slice(before);
		expect(applies.map((call) => `${call.kind}/${call.name}`)).toEqual(['Deployment/dep-smtp']);
		expect(applies[0].object?.spec).toEqual({ replicas: 0 });
		expect(cluster.deleted()).toEqual([]);
	});

	it('defaults the port to 587, implicit TLS to port 465, and from to the user when it is an address', () => {
		expect(externalSmtpServer(context({ config: { host: 'mail.test' } }))).toEqual({
			host: 'mail.test',
			port: 587,
			user: '',
			password: '',
			from: '',
			secure: false
		});
		expect(
			externalSmtpServer(context({ config: { host: 'mail.test', port: '465', user: 'a@b.test' } }))
		).toMatchObject({
			port: 465,
			secure: true,
			from: 'a@b.test'
		});
		expect(
			externalSmtpServer(context({ config: { host: 'mail.test', port: '465', secure: 'false' } }))
		).toMatchObject({
			secure: false
		});
		expect(externalSmtpServer(context({ config: {} }))).toBeNull();
		expect(externalSmtpServer(context())).toBeNull();
	});

	it('refuses an unusable port definitely, rather than falling back to the sink', async () => {
		const cluster = new FakeDependencyCluster();
		const outcome = await provider(cluster).provision(
			SMTP_PROVIDER_ID,
			context({ config: { host: 'smtp.example.com', port: 'abc' } })
		);
		expect(outcome).toMatchObject({ state: 'failed', reason: 'smtpConnectFailed', transient: false });
		expect(cluster.ops('apply')).toEqual([]);
	});

	it('re-reads the configuration as its outputs, and reports the backup as the owner’s', async () => {
		const smtp = provider(new FakeDependencyCluster());
		expect((await smtp.getOutputs(SMTP_PROVIDER_ID, context({ config }))).host).toBe('smtp.example.com');
		expect(await smtp.backupStatus(SMTP_PROVIDER_ID, context({ config }))).toEqual({ state: 'external' });
		expect(await smtp.backupStatus(SMTP_PROVIDER_ID, context())).toEqual({ state: 'none' });
	});
});

describe('k8s-inline-mailpit — deprovision', () => {
	it('makes no cluster call on a plain release', async () => {
		const cluster = new FakeDependencyCluster();
		await provider(cluster).provision(SMTP_PROVIDER_ID, context());
		const calls = cluster.calls.length;
		expect(await provider(cluster).deprovision(SMTP_PROVIDER_ID, context(), { deleteData: false })).toEqual({
			state: 'released'
		});
		expect(cluster.calls.length).toBe(calls);
	});

	it('scales the sink to zero for stopWorkloads and touches nothing else', async () => {
		const cluster = new FakeDependencyCluster();
		await provider(cluster).provision(SMTP_PROVIDER_ID, context());
		await provider(cluster).deprovision(SMTP_PROVIDER_ID, context(), { deleteData: false, stopWorkloads: true });
		expect(cluster.stored('Deployment')[0].spec.replicas).toBe(0);
		expect(cluster.deleted()).toEqual([]);
		expect(cluster.stored('Secret')).toHaveLength(1);
	});

	it('deletes every dep-smtp object on deleteData', async () => {
		const cluster = new FakeDependencyCluster();
		await provider(cluster).provision(SMTP_PROVIDER_ID, context());
		expect(await provider(cluster).deprovision(SMTP_PROVIDER_ID, context(), { deleteData: true })).toEqual({
			state: 'deleted'
		});
		expect(cluster.deleted().sort()).toEqual([
			'Deployment/dep-smtp',
			'NetworkPolicy/dep-smtp',
			'Secret/dep-smtp',
			'Service/dep-smtp'
		]);
	});
});

describe('the k8s plugin publishes and delegates the smtp provider', () => {
	it('lists the descriptor and routes every member to the provider', async () => {
		const cluster = new FakeDependencyCluster();
		const plugin = new KubernetesPlugin({ api: cluster as unknown as KubernetesApiService });

		expect(plugin.dependencyProviders).toContainEqual(SMTP_PROVIDER_DESCRIPTOR);
		expect(await plugin.supports('smtp', 'your-cluster', context())).toEqual({
			supported: true,
			providerId: SMTP_PROVIDER_ID
		});
		expect(await plugin.supports('smtp', 'ever-works-apps', context())).toMatchObject({ supported: false });

		const outcome = await plugin.provision(SMTP_PROVIDER_ID, context());
		expect(outcome.state).toBe('ready');
		expect(cluster.appliedNames()).toContain('Deployment/dep-smtp');
		expect(await plugin.backupStatus(SMTP_PROVIDER_ID, context())).toEqual({ state: 'none' });
		expect(await plugin.deprovision(SMTP_PROVIDER_ID, context(), { deleteData: false })).toEqual({
			state: 'released'
		});
	});
});
