/**
 * T6 — `app-manifest.renderer.ts` (plan §4.1–§4.7, §4.11, §4.12; spec FR-10/FR-16/FR-17/FR-19/
 * FR-20/FR-24/FR-44; ACC-06-07, ACC-06-15, ACC-06-16, ACC-06-17, ACC-06-18, ACC-06-54, ACC-06-58).
 *
 * Every clause of T6's `**Test**` line (tasks.md:126-138) has an `it` below whose title names the
 * clause, so a reviewer can walk that sentence without reading the implementation. The golden
 * fixtures under `./fixtures/` are built from APW-03 `schema.md` §24 (plan §12.1:1670-1672).
 *
 * Pure functions only — no clock, no I/O, no cluster access. Where a value would otherwise come
 * from the outside (the verification expiry instant, the previous volume sizes, the hairpin
 * address) it is a parameter, never a call.
 *
 * Fixtures carry no secret, digest or hostname from the real world: RFC 2606 hosts, RFC 5737
 * addresses and synthetic 64-hex digests only.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { AppRenderInput } from '@ever-works/plugin';

import {
	APP_BUILD_COMMIT_ANNOTATION,
	APP_DEPLOYMENT_ID_ANNOTATION,
	APP_ENV_CHECKSUM_ANNOTATION,
	APP_ENV_CHECKSUM_LENGTH,
	APP_PLATFORM_CONFIGMAP_FORBIDDEN_KEYS,
	appEnvChecksum,
	componentDeadlineSeconds,
	cpuLimitForTarget,
	defaultLimitRangeForTarget,
	normaliseAppHost,
	planAppRender,
	platformValues,
	primaryWebComponent,
	renderAppObjects,
	renderComponentDeployment,
	renderComponentService,
	renderComponentVolume,
	renderEnvSecret,
	renderIngress,
	renderLimitRange,
	renderNamespace,
	renderPlatformConfigMap,
	renderPrepareNamespace,
	renderPullSecret,
	renderPvc,
	renderResourceQuota,
	renderServiceAccount,
	validateRenderInput,
	type AppRenderOptions,
	type AppRenderPlan,
	type AppRenderRefusal,
	type AppRenderedObject
} from '../app-manifest.renderer';
import { APP_FORBIDDEN_LABEL_KEYS } from '../app-names';
import { planAppJobs } from '../app-jobs.renderer';

// --- fixture plumbing -------------------------------------------------------

function fixture(name: string): AppRenderInput {
	return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as AppRenderInput;
}

function golden(name: string): unknown {
	return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

/** A structural view of a rendered object for assertions — the renderer's output is plain JSON. */
type Json = Record<string, any>;
const asJson = (object: AppRenderedObject): Json => object as unknown as Json;

const SINGLE_WEB = 'render-input.single-web.json';
const WEB_WORKER_VOLUME = 'render-input.web-worker-volume.json';
const TWO_WEB = 'render-input.two-web-components.json';

function withInput(
	base: AppRenderInput,
	change: (draft: Json) => void,
	options?: AppRenderOptions
): { input: AppRenderInput; plan: AppRenderPlan; options?: AppRenderOptions } {
	const draft = JSON.parse(JSON.stringify(base)) as Json;
	change(draft);
	const input = draft as unknown as AppRenderInput;
	return { input, plan: planAppRender(input, options), options };
}

function deploymentIn(plan: AppRenderPlan, name: string): Json {
	const found = plan.objects.find((object) => object.kind === 'Deployment' && object.metadata.name === name);
	expect(found, `a Deployment named ${name}`).toBeDefined();
	return asJson(found as AppRenderedObject);
}

const podSpecOf = (deployment: Json): Json => deployment.spec.template.spec;
const podTemplateOf = (deployment: Json): Json => deployment.spec.template;
const containerOf = (deployment: Json): Json => podSpecOf(deployment).containers[0];

const namesOf = (objects: readonly AppRenderedObject[]): string[] => objects.map((object) => object.metadata.name);

function objectNamed(plan: AppRenderPlan, kind: string, name: string): Json | undefined {
	const found = plan.objects.find((object) => object.kind === kind && object.metadata.name === name);
	return found ? asJson(found) : undefined;
}

// --- T6: "digest image" -----------------------------------------------------

describe('T6 — digest-pinned image', () => {
	it('renders the render input’s digest-pinned reference verbatim, with IfNotPresent', () => {
		const plan = planAppRender(fixture(SINGLE_WEB));
		const container = containerOf(deploymentIn(plan, 'web'));

		expect(container.image).toBe(
			'registry.example.com/example-org/analytics@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
		);
		expect(container.image).toMatch(/@sha256:[0-9a-f]{64}$/);
		// §4.3: a digest-pinned reference makes `Always` pointless.
		expect(container.imagePullPolicy).toBe('IfNotPresent');
	});

	it('adds imagePullSecrets only when the render input carries a pull credential (FR-19)', () => {
		const withoutPull = deploymentIn(planAppRender(fixture(SINGLE_WEB)), 'web');
		expect(podSpecOf(withoutPull).imagePullSecrets).toBeUndefined();

		const withPull = deploymentIn(planAppRender(fixture(TWO_WEB)), 'web');
		expect(podSpecOf(withPull).imagePullSecrets).toEqual([{ name: 'app-pull' }]);
	});
});

// --- T6: "Recreate with volumes" -------------------------------------------

describe('T6 — strategy by volume (plan §4.3)', () => {
	it('uses Recreate for a component that declares a volume', () => {
		const plan = planAppRender(fixture(WEB_WORKER_VOLUME));
		expect(deploymentIn(plan, 'worker').spec.strategy).toEqual({ type: 'Recreate' });
	});

	it('uses RollingUpdate maxSurge 0 / maxUnavailable 1 for a single replica without volumes', () => {
		const plan = planAppRender(fixture(SINGLE_WEB));
		expect(deploymentIn(plan, 'web').spec.strategy).toEqual({
			type: 'RollingUpdate',
			rollingUpdate: { maxSurge: 0, maxUnavailable: 1 }
		});
	});

	it('uses RollingUpdate maxSurge 1 / maxUnavailable 0 above one replica without volumes', () => {
		const { plan } = withInput(fixture(SINGLE_WEB), (draft) => {
			draft.components.push({
				...draft.components[0],
				name: 'worker',
				role: 'worker',
				port: undefined,
				replicas: 2,
				primary: false,
				probes: {}
			});
		});

		expect(deploymentIn(plan, 'worker').spec.strategy).toEqual({
			type: 'RollingUpdate',
			rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }
		});
	});

	it('carries revisionHistoryLimit 5 and the component deadline as progressDeadlineSeconds', () => {
		const deployment = deploymentIn(planAppRender(fixture(SINGLE_WEB)), 'web');
		expect(deployment.spec.revisionHistoryLimit).toBe(5);
		expect(deployment.spec.progressDeadlineSeconds).toBe(750);
	});

	it('sets minReadySeconds 30 for a worker without probes and 0 otherwise (plan §4.3)', () => {
		const plan = planAppRender(fixture(WEB_WORKER_VOLUME));
		expect(deploymentIn(plan, 'worker').spec.minReadySeconds).toBe(30);
		expect(deploymentIn(plan, 'web').spec.minReadySeconds).toBe(0);
	});
});

// --- T6: "envFrom not optional" --------------------------------------------

describe('T6 — envFrom is never optional (plan §4.3)', () => {
	it('reads the env Secret and the platform ConfigMap with optional: false', () => {
		const container = containerOf(deploymentIn(planAppRender(fixture(SINGLE_WEB)), 'web'));

		expect(container.envFrom).toEqual([
			{ secretRef: { name: 'app-env-9c1f0a4b7d', optional: false } },
			{ configMapRef: { name: 'app-platform-9c1f0a4b7d', optional: false } }
		]);
	});

	it('renders no inline env value on any container, ever', () => {
		const plan = planAppRender(fixture(WEB_WORKER_VOLUME));
		for (const object of plan.objects.filter((candidate) => candidate.kind === 'Deployment')) {
			expect(containerOf(asJson(object)).env).toBeUndefined();
		}
	});
});

// --- T6: "no env value in any pod spec and no pull credential other than the render input's"
// (ACC-06-16) ---------------------------------------------------------------

describe('T6 — ACC-06-16: no env value in any pod spec, no foreign pull credential', () => {
	const LONG_ENOUGH_TO_BE_UNIQUE = 8;

	it('writes no env value into any rendered pod spec', () => {
		const input = fixture(WEB_WORKER_VOLUME);
		const plan = planAppRender(input);
		const podSpecs = plan.objects
			.filter((object) => object.kind === 'Deployment')
			.map((object) => JSON.stringify(asJson(object).spec.template));

		// Values shorter than 8 characters are deliberately skipped: a value like `1` or `false`
		// occurs inside ordinary JSON numbers and booleans, so a substring check on it would be a
		// coin flip rather than an assertion.
		const values = Object.values(input.env.values).filter((value) => value.length >= LONG_ENOUGH_TO_BE_UNIQUE);

		expect(values.length).toBeGreaterThan(0);
		for (const value of values) {
			for (const podSpec of podSpecs) {
				expect(podSpec).not.toContain(value);
			}
		}
	});

	it('keeps every env value out of every object except the env Secret itself', () => {
		const input = fixture(WEB_WORKER_VOLUME);
		const plan = planAppRender(input);
		const envSecretName = plan.envSecretName;

		const others = plan.objects
			.filter((object) => !(object.kind === 'Secret' && object.metadata.name === envSecretName))
			.map((object) => JSON.stringify(object));

		for (const [name, value] of Object.entries(input.env.values)) {
			if (value.length < LONG_ENOUGH_TO_BE_UNIQUE) continue;
			for (const rendered of others) {
				expect(rendered, `${name} must not leak`).not.toContain(value);
			}
		}
	});

	it('encodes exactly the render input’s pull credential in app-pull and nothing else', () => {
		const input = fixture(TWO_WEB);
		const plan = planAppRender(input);
		const decoded = JSON.parse(
			Buffer.from(
				asJson(plan.objects.find((o) => o.kind === 'Secret' && o.metadata.name === 'app-pull')!).data[
					'.dockerconfigjson'
				],
				'base64'
			).toString('utf8')
		);

		expect(Object.keys(decoded.auths)).toEqual([input.image.pull!.server]);
		expect(decoded.auths[input.image.pull!.server]).toEqual({
			username: input.image.pull!.username,
			password: input.image.pull!.password,
			auth: Buffer.from(`${input.image.pull!.username}:${input.image.pull!.password}`).toString('base64')
		});
	});

	it('writes the pull password into no other object', () => {
		const input = fixture(TWO_WEB);
		const plan = planAppRender(input);
		const password = input.image.pull!.password;

		for (const object of plan.objects) {
			if (object.kind === 'Secret' && object.metadata.name === 'app-pull') continue;
			expect(JSON.stringify(object)).not.toContain(password);
		}
	});

	it('renders no dockerconfigjson-shaped object when the render input has no pull credential', () => {
		const plan = planAppRender(fixture(SINGLE_WEB));
		expect(objectNamed(plan, 'Secret', 'app-pull')).toBeUndefined();
		expect(plan.objects.some((object) => object.kind === 'Secret' && 'data' in object)).toBe(false);
	});
});

// --- T6: "automountServiceAccountToken: false", "enableServiceLinks: false" (ACC-06-07) --------

describe('T6 — ACC-06-07: pod identity and service links', () => {
	it('sets automountServiceAccountToken false on the ServiceAccount and on every pod spec', () => {
		const plan = planAppRender(fixture(WEB_WORKER_VOLUME));
		const serviceAccount = asJson(plan.objects.find((object) => object.kind === 'ServiceAccount')!);

		expect(serviceAccount.metadata.name).toBe('app');
		expect(serviceAccount.automountServiceAccountToken).toBe(false);

		for (const object of plan.objects.filter((candidate) => candidate.kind === 'Deployment')) {
			const podSpec = podSpecOf(asJson(object));
			expect(podSpec.serviceAccountName).toBe('app');
			expect(podSpec.automountServiceAccountToken).toBe(false);
		}
	});

	it('sets enableServiceLinks false on every pod spec', () => {
		const plan = planAppRender(fixture(WEB_WORKER_VOLUME));
		for (const object of plan.objects.filter((candidate) => candidate.kind === 'Deployment')) {
			expect(podSpecOf(asJson(object)).enableServiceLinks).toBe(false);
		}
	});

	it('renders no cluster credential, no privilege escalation and all capabilities dropped', () => {
		const container = containerOf(deploymentIn(planAppRender(fixture(WEB_WORKER_VOLUME)), 'web'));

		expect(container.securityContext.allowPrivilegeEscalation).toBe(false);
		expect(container.securityContext.capabilities).toEqual({ drop: ['ALL'] });
		expect(container.securityContext.readOnlyRootFilesystem).toBe(true);
		expect(podSpecOf(deploymentIn(planAppRender(fixture(WEB_WORKER_VOLUME)), 'web')).securityContext).toMatchObject(
			{
				runAsNonRoot: true,
				seccompProfile: { type: 'RuntimeDefault' }
			}
		);
	});

	it('mounts the /tmp emptyDir of §4.4 for a read-only container and omits it for a writable root', () => {
		const readOnly = deploymentIn(planAppRender(fixture(WEB_WORKER_VOLUME)), 'web');
		expect(containerOf(readOnly).volumeMounts).toContainEqual({ name: 'tmp', mountPath: '/tmp' });
		expect(podSpecOf(readOnly).volumes).toContainEqual({ name: 'tmp', emptyDir: { sizeLimit: '256Mi' } });

		const writable = deploymentIn(planAppRender(fixture(TWO_WEB)), 'web');
		expect(containerOf(writable).securityContext.readOnlyRootFilesystem).toBe(false);
		expect(containerOf(writable).volumeMounts).toBeUndefined();
		expect(podSpecOf(writable).volumes).toBeUndefined();
	});

	it('passes a component’s optional numeric runAsUser through verbatim (plan §4.4, APW06-G26)', () => {
		const plan = planAppRender(fixture(TWO_WEB));
		expect(podSpecOf(deploymentIn(plan, 'admin')).securityContext.runAsUser).toBe(10001);
		expect(podSpecOf(deploymentIn(plan, 'web')).securityContext.runAsUser).toBeUndefined();
	});
});

// --- T6: "the pod template's ever-works.io/env-checksum changes when one env value changes and
// is byte-identical otherwise" (ACC-06-15) -----------------------------------

describe('T6 — ACC-06-15: the env checksum pins pod identity', () => {
	it('uses the render input’s checksum for the annotation and both envFrom names', () => {
		const input = fixture(SINGLE_WEB);
		const plan = planAppRender(input);
		const template = podTemplateOf(deploymentIn(plan, 'web'));

		expect(template.metadata.annotations[APP_ENV_CHECKSUM_ANNOTATION]).toBe(input.env.checksum);
		expect(plan.envSecretName).toBe('app-env-9c1f0a4b7d');
		expect(plan.platformConfigMapName).toBe('app-platform-9c1f0a4b7d');
	});

	it('changes the pod template annotation and both object names when one env value changes', () => {
		const base = fixture(SINGLE_WEB);
		const changed = JSON.parse(JSON.stringify(base)) as Json;
		changed.env.values.DISABLE_TELEMETRY = '0';
		changed.env.checksum = appEnvChecksum(changed.env.values, platformValues(changed as unknown as AppRenderInput));

		const before = planAppRender(base);
		const after = planAppRender(changed as unknown as AppRenderInput);

		expect(appEnvChecksum(base.env.values, platformValues(base))).not.toBe(
			appEnvChecksum(changed.env.values, platformValues(changed as unknown as AppRenderInput))
		);
		expect(podTemplateOf(deploymentIn(after, 'web')).metadata.annotations[APP_ENV_CHECKSUM_ANNOTATION]).not.toBe(
			podTemplateOf(deploymentIn(before, 'web')).metadata.annotations[APP_ENV_CHECKSUM_ANNOTATION]
		);
		expect(after.envSecretName).not.toBe(before.envSecretName);
		expect(after.platformConfigMapName).not.toBe(before.platformConfigMapName);
	});

	it('renders a byte-identical pod template when nothing about the Build, env or spec changed', () => {
		const input = fixture(SINGLE_WEB);
		const first = planAppRender(input);
		const second = planAppRender(fixture(SINGLE_WEB));

		expect(JSON.stringify(podTemplateOf(deploymentIn(second, 'web')))).toBe(
			JSON.stringify(podTemplateOf(deploymentIn(first, 'web')))
		);
	});

	it('derives the same checksum from the same values whatever the key order', () => {
		const base = fixture(SINGLE_WEB);
		const reordered = {
			...base.env.values,
			DATABASE_URL: base.env.values.DATABASE_URL
		};

		expect(appEnvChecksum(reordered, {})).toBe(appEnvChecksum({ ...base.env.values }, {}));
		expect(appEnvChecksum(base.env.values, {})).toMatch(new RegExp(`^[0-9a-f]{${APP_ENV_CHECKSUM_LENGTH}}$`));
	});

	it('computes the checksum when the render input carries none', () => {
		const source = fixture(SINGLE_WEB);
		const { plan } = withInput(source, (draft) => {
			delete draft.env.checksum;
		});

		// §4.7: the checksum covers **both** maps — the env Secret's values and the platform
		// ConfigMap's — which is why the platform values are the second argument.
		expect(plan.envChecksum).toBe(appEnvChecksum(source.env.values, platformValues(source)));
		expect(plan.envChecksum).not.toBe(appEnvChecksum(source.env.values, {}));
		expect(podTemplateOf(deploymentIn(plan, 'web')).metadata.annotations[APP_ENV_CHECKSUM_ANNOTATION]).toBe(
			plan.envChecksum
		);
	});
});

// --- T6: "rendering twice with different deploymentId / deploymentShort ... yields byte-identical
// component spec.templates and identical envFrom object names, puts ever-works.io/deployment-id
// only under the Deployment's metadata.annotations, and leaves no EVER_WORKS_DEPLOYMENT_ID key in
// the platform ConfigMap (ACC-06-58, APW06-G07)" ----------------------------

describe('T6 — ACC-06-58 / APW06-G07: no per-Deployment fact in a pod template', () => {
	const otherDeployment = (base: AppRenderInput): AppRenderInput => {
		const draft = JSON.parse(JSON.stringify(base)) as Json;
		draft.deploymentId = 'aaaa1111-9999-4bbb-8ccc-ddddeeeeffff';
		draft.deploymentShort = 'aaaa1111';
		return draft as unknown as AppRenderInput;
	};

	it('renders byte-identical component pod templates for two Deployment ids over the same Build, env and spec', () => {
		const first = planAppRender(fixture(WEB_WORKER_VOLUME));
		const second = planAppRender(otherDeployment(fixture(WEB_WORKER_VOLUME)));

		const templates = (plan: AppRenderPlan): string[] =>
			plan.objects
				.filter((object) => object.kind === 'Deployment')
				.map((object) => JSON.stringify(asJson(object).spec.template));

		expect(templates(second)).toEqual(templates(first));
		expect(JSON.stringify(second.envSecretName)).toBe(JSON.stringify(first.envSecretName));
		expect(containerOf(deploymentIn(second, 'web')).envFrom).toEqual(
			containerOf(deploymentIn(first, 'web')).envFrom
		);
	});

	it('puts ever-works.io/deployment-id on the Deployment metadata only', () => {
		const input = fixture(WEB_WORKER_VOLUME);
		const plan = planAppRender(input);

		for (const object of plan.objects.filter((candidate) => candidate.kind === 'Deployment')) {
			expect(asJson(object).metadata.annotations[APP_DEPLOYMENT_ID_ANNOTATION]).toBe(input.deploymentId);
			expect(JSON.stringify(asJson(object).spec.template)).not.toContain(input.deploymentId);
			expect(JSON.stringify(asJson(object).spec.template)).not.toContain(APP_DEPLOYMENT_ID_ANNOTATION);
			expect(JSON.stringify(asJson(object).spec.template)).not.toContain(input.deploymentShort);
		}
	});

	it('leaves no EVER_WORKS_DEPLOYMENT_ID key in the platform ConfigMap', () => {
		const configMap = objectNamed(planAppRender(fixture(SINGLE_WEB)), 'ConfigMap', 'app-platform-9c1f0a4b7d')!;

		expect(configMap.data).toBeDefined();
		expect(Object.keys(configMap.data)).not.toContain('EVER_WORKS_DEPLOYMENT_ID');
		expect(APP_PLATFORM_CONFIGMAP_FORBIDDEN_KEYS).toContain('EVER_WORKS_DEPLOYMENT_ID');
		expect(JSON.stringify(configMap)).not.toContain('EVER_WORKS_DEPLOYMENT_ID');
	});

	it('ignores an EVER_WORKS_DEPLOYMENT_ID a caller tries to smuggle in through the platform values', () => {
		const configMap = renderPlatformConfigMap(fixture(SINGLE_WEB), {
			platform: { EVER_WORKS_DEPLOYMENT_ID: 'should-never-be-written' }
		});

		expect(JSON.stringify(configMap)).not.toContain('EVER_WORKS_DEPLOYMENT_ID');
		expect(JSON.stringify(configMap)).not.toContain('should-never-be-written');
	});

	it('keeps the per-Deployment identity out of the env Secret and the namespace too', () => {
		const input = fixture(SINGLE_WEB);
		const plan = planAppRender(input);

		expect(JSON.stringify(renderEnvSecret(input))).not.toContain(input.deploymentId);
		expect(JSON.stringify(plan.objects.find((object) => object.kind === 'Namespace'))).not.toContain(
			input.deploymentId
		);
	});
});

// --- T6: "Ingress only for the primary web component; strict host validation" -----------------

describe('T6 — Ingress (plan §4.3, §4.11)', () => {
	it('renders an Ingress for the primary web component only', () => {
		const plan = planAppRender(fixture(TWO_WEB));
		const ingresses = plan.objects.filter((object) => object.kind === 'Ingress');

		expect(ingresses).toHaveLength(1);
		expect(ingresses[0].metadata.name).toBe('web');
		expect(primaryWebComponent(fixture(TWO_WEB))?.name).toBe('web');
		expect(objectNamed(plan, 'Ingress', 'admin')).toBeUndefined();
	});

	it('renders no Ingress for a worker-only set of components', () => {
		const { plan } = withInput(fixture(SINGLE_WEB), (draft) => {
			draft.components[0].role = 'worker';
			draft.components[0].port = undefined;
			draft.components[0].primary = false;
		});

		expect(plan.objects.filter((object) => object.kind === 'Ingress')).toHaveLength(0);
		expect(renderIngress(fixture(SINGLE_WEB), {})).not.toBeNull();
	});

	it('renders a rule for the primary host plus every extra and previous host', () => {
		const ingress = asJson(renderIngress(fixture(WEB_WORKER_VOLUME), {})!);

		expect(ingress.spec.rules.map((rule: Json) => rule.host)).toEqual([
			'helpdesk.example.com',
			'support.example.com',
			'old-helpdesk.example.com'
		]);
		expect(ingress.spec.rules[0].http.paths[0]).toEqual({
			path: '/',
			pathType: 'Prefix',
			backend: { service: { name: 'web', port: { number: 80 } } }
		});
	});

	it('rejects a host that is not a strict RFC-1123 hostname', () => {
		expect(normaliseAppHost('app.example.com')).toBe('app.example.com');
		expect(normaliseAppHost('APP.Example.COM')).toBe('app.example.com');
		expect(normaliseAppHost('*.example.com')).toBeNull();
		expect(normaliseAppHost('https://app.example.com/')).toBeNull();
		expect(normaliseAppHost('app_example.com')).toBeNull();
		expect(normaliseAppHost('-app.example.com')).toBeNull();
		expect(normaliseAppHost('')).toBeNull();
		expect(normaliseAppHost(`${'a'.repeat(64)}.example.com`)).toBeNull();

		const { plan } = withInput(fixture(SINGLE_WEB), (draft) => {
			draft.hosts.extra = ['good.example.com', '*.evil.example.com', 'https://worse.example.com'];
		});
		const ingress = asJson(plan.objects.find((object) => object.kind === 'Ingress')!);

		expect(ingress.spec.rules.map((rule: Json) => rule.host)).toEqual([
			'analytics.example.com',
			'good.example.com'
		]);
		expect(JSON.stringify(ingress)).not.toContain('evil.example.com');
		expect(JSON.stringify(ingress)).not.toContain('worse.example.com');
	});

	it('renders a TLS block only for cert-manager, with the issuer annotation', () => {
		const certManager = asJson(renderIngress(fixture(SINGLE_WEB), {})!);
		expect(certManager.spec.tls).toEqual([
			{ hosts: ['analytics.example.com'], secretName: 'analytics-example-com-tls' }
		]);
		expect(certManager.metadata.annotations['cert-manager.io/cluster-issuer']).toBe('letsencrypt');

		const none = asJson(renderIngress(fixture(TWO_WEB), {})!);
		expect(none.spec.tls).toBeUndefined();
		expect(none.metadata.annotations['cert-manager.io/cluster-issuer']).toBeUndefined();
	});

	it('renders no Ingress when no class exists and no default class was detected (warning no_ingress_controller)', () => {
		const { plan } = withInput(fixture(SINGLE_WEB), (draft) => {
			draft.ingress.className = null;
		});

		expect(plan.objects.filter((object) => object.kind === 'Ingress')).toHaveLength(0);
		expect(plan.warnings.map((warning) => warning.code)).toContain('no_ingress_controller');
	});

	it('falls back to the detected default IngressClass when the input names none', () => {
		const { plan } = withInput(
			fixture(SINGLE_WEB),
			(draft) => {
				draft.ingress.className = null;
			},
			{ defaultIngressClass: 'nginx' }
		);

		expect(asJson(plan.objects.find((object) => object.kind === 'Ingress')!).spec.ingressClassName).toBe('nginx');
	});
});

// --- T6: "deadline clamp at 300 and 2400" ----------------------------------

describe('T6 — componentDeadlineSeconds (plan §5.3)', () => {
	const component = (startup: Json | undefined, readiness: Json | undefined): Json => ({
		name: 'web',
		role: 'web',
		probes: { startup, readiness }
	});
	const probe = (periodSeconds: number, failureThreshold: number): Json => ({
		periodSeconds,
		timeoutSeconds: 5,
		initialDelaySeconds: 0,
		failureThreshold
	});

	it('applies the renderer’s web defaults: 10×60 + 10×3 + 120 = 750', () => {
		expect(componentDeadlineSeconds(component(undefined, undefined))).toBe(750);
		expect(componentDeadlineSeconds(component(probe(10, 60), probe(10, 3)))).toBe(750);
	});

	it('clamps the low end at 300', () => {
		expect(componentDeadlineSeconds(component(probe(1, 1), probe(1, 1)))).toBe(300);
	});

	it('clamps the high end at 2400', () => {
		expect(componentDeadlineSeconds(component(probe(300, 120), probe(300, 120)))).toBe(2400);
	});

	it('returns the unclamped sum inside the range', () => {
		expect(componentDeadlineSeconds(component(probe(10, 60), probe(10, 30)))).toBe(1020);
	});

	it('is written into progressDeadlineSeconds, clamped', () => {
		const { plan } = withInput(fixture(SINGLE_WEB), (draft) => {
			draft.components[0].deadlineSeconds = 9999;
		});

		// A resolved deadline of 9999 is not a legal progressDeadlineSeconds: the formula's ceiling wins.
		expect(deploymentIn(plan, 'web').spec.progressDeadlineSeconds).toBe(2400);
	});
});

// --- T6: "a component with a volume and replicas: 2 → volume_replicas (ACC-06-18)" -----------

describe('T6 — validateRenderInput (plan §5.1 render-time checks)', () => {
	const codes = (refusals: readonly AppRenderRefusal[]): string[] => refusals.map((refusal) => refusal.code);

	it('returns volume_replicas for a component with a volume and replicas: 2', () => {
		const { input } = withInput(fixture(WEB_WORKER_VOLUME), (draft) => {
			draft.components[1].replicas = 2;
		});
		const validation = validateRenderInput(input);

		expect(codes(validation.volume_replicas)).toEqual(['volume_replicas']);
		expect(validation.volume_replicas[0].names).toEqual(['worker']);
		expect(validation.ok).toBe(false);
	});

	it('accepts a component with a volume and one replica', () => {
		const validation = validateRenderInput(fixture(WEB_WORKER_VOLUME));
		expect(validation.volume_replicas).toEqual([]);
		expect(codes(validation.refusals)).not.toContain('volume_replicas');
	});

	it('returns volume_shrink when a requested claim is smaller than the existing one', () => {
		const input = fixture(WEB_WORKER_VOLUME);
		const validation = validateRenderInput(input, { existingVolumes: { 'worker-uploads': '10Gi' } });

		expect(codes(validation.volume_shrink)).toEqual(['volume_shrink']);
		expect(validation.volume_shrink[0].names).toEqual(['worker-uploads']);
		expect(validateRenderInput(input, { existingVolumes: { 'worker-uploads': '5Gi' } }).volume_shrink).toEqual([]);
		expect(validateRenderInput(input, { existingVolumes: { 'worker-uploads': '2Gi' } }).ok).toBe(true);
	});

	it('returns no refusal for a first Deployment (no existing claims)', () => {
		expect(validateRenderInput(fixture(WEB_WORKER_VOLUME)).refusals).toEqual([]);
		expect(validateRenderInput(fixture(WEB_WORKER_VOLUME)).ok).toBe(true);
	});

	it('reports all three codes in one call, in plan §5.1’s order', () => {
		const { input } = withInput(fixture(TWO_WEB), (draft) => {
			draft.ref.target = 'ever-works-apps';
			draft.components[1].port = 80;
			draft.components[1].replicas = 2;
		});
		const validation = validateRenderInput(input, { existingVolumes: { 'admin-media': '4Gi' } });

		expect(codes(validation.refusals)).toEqual(['volume_replicas', 'volume_shrink', 'privileged_port']);
		expect(validation.ok).toBe(false);
	});

	it('never reports privileged_port on your-cluster (plan §4.4)', () => {
		const { input } = withInput(fixture(TWO_WEB), (draft) => {
			draft.components[1].port = 80;
		});

		expect(validateRenderInput(input).privileged_port).toEqual([]);
	});
});

// --- T6: "the prepare-namespace subset renders the namespace, the ServiceAccount and the
// LimitRange and — with isolation: true — exactly ew-default-deny, ew-allow-same-namespace and
// ew-allow-egress, never ew-allow-ingress / ew-allow-deps (ACC-06-54, plan §4.2)" ------------

describe('T6 — ACC-06-54: the prepare-namespace subset (plan §4.2)', () => {
	it('renders the namespace, the ServiceAccount, the LimitRange and exactly the three baseline policies', () => {
		const input = fixture(SINGLE_WEB);
		const objects = renderPrepareNamespace(input, {});

		expect(objects.map((object) => object.kind)).toEqual([
			'Namespace',
			'ServiceAccount',
			'LimitRange',
			'NetworkPolicy',
			'NetworkPolicy',
			'NetworkPolicy'
		]);
		expect(namesOf(objects)).toEqual([
			'ew-analytics-0f8e2c1a',
			'app',
			'ew-defaults',
			'ew-default-deny',
			'ew-allow-same-namespace',
			'ew-allow-egress'
		]);
		expect(namesOf(objects)).not.toContain('ew-allow-ingress');
		expect(namesOf(objects)).not.toContain('ew-allow-deps');
	});

	it('renders no NetworkPolicy at all with isolation off, while the namespace subset stays whole', () => {
		const { plan } = withInput(
			fixture(SINGLE_WEB),
			(draft) => {
				draft.network.isolation = false;
			},
			{ scope: 'prepare-namespace' }
		);

		expect(plan.objects.filter((object) => object.kind === 'NetworkPolicy')).toHaveLength(0);
		expect(plan.objects.map((object) => object.kind)).toEqual(['Namespace', 'ServiceAccount', 'LimitRange']);
	});

	it('never renders ew-allow-ingress or ew-allow-deps in the prepare-namespace subset', () => {
		for (const purpose of ['deploy', 'verification'] as const) {
			const objects = renderPrepareNamespace({ ...fixture(SINGLE_WEB), purpose }, {});
			const policyNames = objects.filter((object) => object.kind === 'NetworkPolicy').map((o) => o.metadata.name);

			expect(policyNames).toEqual(['ew-default-deny', 'ew-allow-same-namespace', 'ew-allow-egress']);
			expect(policyNames.some((name) => name.startsWith('dep-'))).toBe(false);
		}
	});

	it('labels the namespace with the pod-security levels of §4.4 and the Work identity', () => {
		const namespace = asJson(renderNamespace(fixture(SINGLE_WEB), {}));

		expect(namespace.metadata.name).toBe('ew-analytics-0f8e2c1a');
		expect(namespace.metadata.labels['pod-security.kubernetes.io/enforce']).toBe('baseline');
		expect(namespace.metadata.labels['pod-security.kubernetes.io/warn']).toBe('restricted');
		expect(namespace.metadata.labels['pod-security.kubernetes.io/audit']).toBe('restricted');
		expect(namespace.metadata.labels['ever-works.io/work-id']).toBe('0f8e2c1a-1111-4a2b-9c3d-4e5f60718293');
		expect(namespace.metadata.labels['app.kubernetes.io/part-of']).toBe('analytics');
		for (const forbidden of APP_FORBIDDEN_LABEL_KEYS) {
			expect(namespace.metadata.labels).not.toHaveProperty(forbidden);
		}
	});

	it('adds the purpose label and the caller’s expiry instant to a verification namespace', () => {
		const input: AppRenderInput = { ...fixture(SINGLE_WEB), purpose: 'verification', ttlMinutes: 60 };
		const namespace = asJson(renderNamespace(input, { now: '2026-09-18T10:00:00.000Z' }));

		expect(namespace.metadata.labels['ever-works.io/purpose']).toBe('verification');
		expect(namespace.metadata.annotations['ever-works.io/expires-at']).toBe('2026-09-18T11:00:00.000Z');
	});

	it('renders the LimitRange defaults of §4.2 from the render input', () => {
		const limitRange = asJson(renderLimitRange(fixture(SINGLE_WEB)));

		expect(limitRange.metadata.name).toBe('ew-defaults');
		expect(limitRange.spec.limits).toEqual([
			{
				type: 'Container',
				defaultRequest: { cpu: '100m', memory: '128Mi' },
				default: { cpu: '1', memory: '512Mi', 'ephemeral-storage': '1Gi' },
				max: { cpu: '8', memory: '64Gi' }
			}
		]);
		expect(defaultLimitRangeForTarget('ever-works-apps').max).toEqual({ cpu: '2', memory: '4Gi' });
	});

	it('renders the ResourceQuota on ever-works-apps only', () => {
		const { plan } = withInput(fixture(SINGLE_WEB), (draft) => {
			draft.ref.target = 'ever-works-apps';
			draft.policy.podSecurity = 'restricted';
		});
		const quota = asJson(
			renderResourceQuota({
				...fixture(SINGLE_WEB),
				ref: { ...fixture(SINGLE_WEB).ref, target: 'ever-works-apps' }
			})!
		);

		expect(Object.keys(quota.spec.hard)).toHaveLength(13);
		expect(quota.spec.hard).toMatchObject({
			'requests.cpu': '2',
			'limits.cpu': '4',
			'requests.memory': '4Gi',
			'limits.memory': '6Gi',
			pods: 20,
			persistentvolumeclaims: 5,
			'requests.storage': '20Gi',
			'services.loadbalancers': 0,
			'services.nodeports': 0,
			'count/jobs.batch': 20,
			'count/cronjobs.batch': 20,
			secrets: 30,
			configmaps: 30
		});
		expect(objectNamed(plan, 'ResourceQuota', 'ew-quota')).toBeDefined();
		expect(renderResourceQuota(fixture(SINGLE_WEB))).toBeNull();
		expect(objectNamed(planAppRender(fixture(SINGLE_WEB)), 'ResourceQuota', 'ew-quota')).toBeUndefined();
	});

	it('derives the managed CPU limit as max(1, 4 × cpu) when the spec declares none (plan §4.5)', () => {
		expect(cpuLimitForTarget('your-cluster', undefined, undefined)).toBeUndefined();
		expect(cpuLimitForTarget('ever-works-apps', undefined, undefined)).toBe('1');
		expect(cpuLimitForTarget('ever-works-apps', undefined, '500m')).toBe('2');
		expect(cpuLimitForTarget('ever-works-apps', undefined, '2')).toBe('8');
		expect(cpuLimitForTarget('ever-works-apps', '3', '500m')).toBe('3');
		expect(cpuLimitForTarget('your-cluster', '3', '500m')).toBe('3');
	});
});

// --- T6: verification variant (plan §12.1) ---------------------------------

describe('T6 — verification targets render no Ingress and no PVC (plan §4.12)', () => {
	const verification = (): AppRenderInput => ({
		...fixture(WEB_WORKER_VOLUME),
		purpose: 'verification',
		ttlMinutes: 30,
		ref: { ...fixture(WEB_WORKER_VOLUME).ref, namespace: 'ew-helpdesk-1a2b3c4d-v1a2b3c-1' }
	});

	it('renders no Ingress for a verification ref', () => {
		const plan = planAppRender(verification(), { now: '2026-09-18T10:00:00.000Z' });
		expect(plan.objects.filter((object) => object.kind === 'Ingress')).toHaveLength(0);
		expect(renderIngress(verification(), {})).toBeNull();
	});

	it('replaces every PVC with an emptyDir carrying the declared size as sizeLimit', () => {
		const input = verification();
		const plan = planAppRender(input, { now: '2026-09-18T10:00:00.000Z' });
		const worker = deploymentIn(plan, 'worker');

		expect(plan.objects.filter((object) => object.kind === 'PersistentVolumeClaim')).toHaveLength(0);
		expect(podSpecOf(worker).volumes).toContainEqual({ name: 'uploads', emptyDir: { sizeLimit: '5Gi' } });
		expect(containerOf(worker).volumeMounts).toContainEqual({ name: 'uploads', mountPath: '/data/uploads' });
		expect(renderPvc(input, input.components[1], input.components[1].volumes[0])).toBeNull();
	});

	it('renders the PVC for a deploy ref, labelled retain and with the backup annotation', () => {
		const input = fixture(WEB_WORKER_VOLUME);
		const pvc = asJson(renderPvc(input, input.components[1], input.components[1].volumes[0])!);

		expect(pvc.metadata.name).toBe('worker-uploads');
		expect(pvc.metadata.labels['ever-works.io/retain']).toBe('true');
		expect(pvc.metadata.annotations['ever-works.io/backup']).toBe('true');
		expect(pvc.spec).toEqual({
			accessModes: ['ReadWriteOnce'],
			resources: { requests: { storage: '5Gi' } }
		});
		expect(renderComponentVolume(input, input.components[1], input.components[1].volumes[0])).toEqual({
			name: 'uploads',
			persistentVolumeClaim: { claimName: 'worker-uploads' }
		});
	});
});

// --- T6: services and containers -------------------------------------------

describe('T6 — Services and containers (plan §4.3)', () => {
	it('gives every web component a ClusterIP Service on 80 → its declared port, and workers none', () => {
		const plan = planAppRender(fixture(WEB_WORKER_VOLUME));
		const service = asJson(plan.objects.find((object) => object.kind === 'Service')!);

		expect(service.metadata.name).toBe('web');
		expect(service.spec).toEqual({
			type: 'ClusterIP',
			selector: { 'ever-works.io/component': 'web' },
			ports: [{ name: 'http', port: 80, targetPort: 8080, protocol: 'TCP' }]
		});
		expect(plan.objects.filter((object) => object.kind === 'Service')).toHaveLength(1);
		expect(renderComponentService(fixture(WEB_WORKER_VOLUME), fixture(WEB_WORKER_VOLUME).components[1])).toBeNull();
	});

	it('publishes container ports for web components only, named http', () => {
		const plan = planAppRender(fixture(WEB_WORKER_VOLUME));

		expect(containerOf(deploymentIn(plan, 'web')).ports).toEqual([
			{ name: 'http', containerPort: 8080, protocol: 'TCP' }
		]);
		expect(containerOf(deploymentIn(plan, 'worker')).ports).toBeUndefined();
	});

	it('renders the declared command/args and the spec resources', () => {
		const container = containerOf(deploymentIn(planAppRender(fixture(WEB_WORKER_VOLUME)), 'worker'));

		expect(container.command).toEqual(['node', 'dist/worker.js']);
		// §4.5: a declared cpuLimit is used verbatim (and on Your cluster an absent one stays absent —
		// asserted in the managed-CPU-limit test below).
		expect(container.resources).toEqual({
			requests: { cpu: '250m', memory: '512Mi' },
			limits: { cpu: '1', memory: '1Gi' }
		});
		expect(containerOf(deploymentIn(planAppRender(fixture(SINGLE_WEB)), 'web')).resources).toEqual({
			requests: { cpu: '250m', memory: '512Mi' },
			limits: { memory: '1Gi' }
		});
	});

	it('renders declared probes and the web readiness/startup defaults (plan §4.5)', () => {
		const declared = containerOf(deploymentIn(planAppRender(fixture(SINGLE_WEB)), 'web'));
		expect(declared.startupProbe).toEqual({
			httpGet: { path: '/api/heartbeat', port: 'http' },
			periodSeconds: 10,
			timeoutSeconds: 5,
			initialDelaySeconds: 0,
			failureThreshold: 30
		});
		expect(declared.readinessProbe.httpGet).toEqual({ path: '/api/heartbeat', port: 'http' });
		expect(declared.livenessProbe).toBeUndefined();

		const defaulted = containerOf(deploymentIn(planAppRender(fixture(TWO_WEB)), 'web'));
		expect(defaulted.startupProbe).toEqual({
			tcpSocket: { port: 'http' },
			periodSeconds: 10,
			timeoutSeconds: 5,
			initialDelaySeconds: 0,
			failureThreshold: 60
		});
	});

	it('does not add probes to a worker that declares none', () => {
		const container = containerOf(deploymentIn(planAppRender(fixture(WEB_WORKER_VOLUME)), 'worker'));

		expect(container.startupProbe).toBeUndefined();
		expect(container.readinessProbe).toBeUndefined();
		expect(container.livenessProbe).toBeUndefined();
	});

	it('spreads pods softly by hostname, as the site renderer does', () => {
		const podSpec = podSpecOf(deploymentIn(planAppRender(fixture(SINGLE_WEB)), 'web'));

		expect(podSpec.topologySpreadConstraints).toEqual([
			{
				maxSkew: 1,
				topologyKey: 'kubernetes.io/hostname',
				whenUnsatisfiable: 'ScheduleAnyway',
				labelSelector: { matchLabels: { 'ever-works.io/component': 'web' } }
			}
		]);
	});

	it('honours the policy’s runtimeClassName when the target names one', () => {
		const { plan } = withInput(fixture(SINGLE_WEB), (draft) => {
			draft.policy.runtimeClassName = 'gvisor';
		});

		expect(podSpecOf(deploymentIn(plan, 'web')).runtimeClassName).toBe('gvisor');
	});

	it('carries the Work identity on every object and the build commit on the pod template', () => {
		const input = fixture(SINGLE_WEB);
		const plan = planAppRender(input);

		for (const object of plan.objects) {
			expect(object.metadata.labels?.['ever-works.io/work-id']).toBe(input.ref.workId);
			expect(object.metadata.labels?.['ever-works.io/kind']).toBe('app');
			expect(object.metadata.labels?.['app.kubernetes.io/managed-by']).toBe('ever-works-k8s-plugin');
			for (const forbidden of APP_FORBIDDEN_LABEL_KEYS) {
				expect(object.metadata.labels).not.toHaveProperty(forbidden);
			}
		}

		expect(podTemplateOf(deploymentIn(plan, 'web')).metadata.annotations[APP_BUILD_COMMIT_ANNOTATION]).toBe(
			input.specCommitSha
		);
	});

	it('never lets a per-Deployment value reach the pod template or the platform ConfigMap', () => {
		const input = fixture(SINGLE_WEB);
		const plan = planAppRender(input);
		const template = JSON.stringify(podTemplateOf(deploymentIn(plan, 'web')));

		for (const value of [input.deploymentId, input.deploymentShort]) {
			expect(template).not.toContain(value);
		}
		expect(JSON.stringify(objectNamed(plan, 'ConfigMap', plan.platformConfigMapName))).not.toContain(
			input.deploymentId
		);
	});
});

// --- T6: golden fixtures (plan §12.1) --------------------------------------

describe('T6 — golden fixtures for APW-03 schema.md §24 (plan §12.1)', () => {
	it('matches expected.single-web.objects.json', () => {
		expect(JSON.parse(JSON.stringify(renderAppObjects(fixture(SINGLE_WEB))))).toEqual(
			golden('expected.single-web.objects.json')
		);
	});

	it('matches expected.web-worker-volume.objects.json', () => {
		expect(JSON.parse(JSON.stringify(renderAppObjects(fixture(WEB_WORKER_VOLUME))))).toEqual(
			golden('expected.web-worker-volume.objects.json')
		);
	});

	it('matches expected.two-web-components.objects.json', () => {
		expect(JSON.parse(JSON.stringify(renderAppObjects(fixture(TWO_WEB))))).toEqual(
			golden('expected.two-web-components.objects.json')
		);
	});

	it('matches expected.prepare-namespace.json for the isolation-on subset', () => {
		const plan = planAppRender(fixture(SINGLE_WEB), { scope: 'prepare-namespace' });

		expect(JSON.parse(JSON.stringify({ objects: plan.objects, warnings: plan.warnings }))).toEqual(
			golden('expected.prepare-namespace.json')
		);
	});

	it('matches the platform ConfigMap golden, which holds no per-Deployment fact', () => {
		expect(
			JSON.parse(JSON.stringify(renderPlatformConfigMap(fixture(SINGLE_WEB), { urlScheme: 'https' })))
		).toEqual(golden('expected.platform-configmap.json'));
	});
});

// --- T6: the library entry points are pure and total ----------------------

describe('T6 — pure library entry points (R-5)', () => {
	it('renders the same bytes for two identical calls', () => {
		const input = fixture(WEB_WORKER_VOLUME);
		expect(JSON.stringify(planAppRender(input))).toBe(JSON.stringify(planAppRender(fixture(WEB_WORKER_VOLUME))));
	});

	it('never mutates the render input', () => {
		const input = fixture(SINGLE_WEB);
		const snapshot = JSON.stringify(input);

		planAppRender(input, { now: '2026-09-18T10:00:00.000Z' });
		renderPrepareNamespace(input, { now: '2026-09-18T10:00:00.000Z' });
		validateRenderInput(input, { existingVolumes: { 'worker-uploads': '1Gi' } });

		expect(JSON.stringify(input)).toBe(snapshot);
	});

	it('renders the full prepare set in plan §4.2’s apply order', () => {
		const plan = planAppRender(fixture(TWO_WEB));

		expect(plan.objects.map((object) => `${object.kind}/${object.metadata.name}`)).toEqual([
			'Namespace/ew-storefront-99887766',
			'ServiceAccount/app',
			'LimitRange/ew-defaults',
			'NetworkPolicy/ew-default-deny',
			'NetworkPolicy/ew-allow-same-namespace',
			'NetworkPolicy/ew-allow-egress',
			'NetworkPolicy/ew-allow-ingress',
			'NetworkPolicy/ew-allow-deps',
			'Secret/app-pull',
			'Secret/app-env-5a4b3c2d1e',
			'ConfigMap/app-platform-5a4b3c2d1e',
			'PersistentVolumeClaim/admin-media',
			'Service/web',
			'Service/admin',
			'Deployment/web',
			'Deployment/admin',
			'Ingress/web'
		]);
	});

	it('reports refusals alongside the objects without rendering a partial plan', () => {
		const { input } = withInput(fixture(WEB_WORKER_VOLUME), (draft) => {
			draft.components[1].replicas = 3;
		});
		const plan = planAppRender(input);

		expect(plan.refusals.map((refusal) => refusal.code)).toEqual(['volume_replicas']);
		expect(plan.objects.filter((object) => object.kind === 'Deployment')).toHaveLength(2);
	});

	it('accepts a component with a volume and one replica as valid', () => {
		expect(
			renderComponentDeployment(fixture(WEB_WORKER_VOLUME), fixture(WEB_WORKER_VOLUME).components[1]).kind
		).toBe('Deployment');
	});
});

// --- T60: a verification target's whole plan, and the proof a normal one is untouched -----------

/**
 * APW-06 T60, plan §4.12:649-652 — "**Not rendered**: Ingress, TLS, CronJobs, DNS records, custom
 * domains, PVCs — every volume becomes an `emptyDir` with the declared size as `sizeLimit`".
 *
 * The verification branch itself landed with T4/T6; what this block adds is the four clauses a
 * reviewer has to be able to walk in one place, each with the **control** that proves the assertion
 * is about the verification branch rather than about a fixture that happens to have nothing:
 *
 * | Clause of §4.12:649-652            | The control (the same input, `purpose: 'deploy'`) |
 * | ---------------------------------- | ------------------------------------------------- |
 * | no Ingress and no TLS block        | renders `Ingress/web` with a `spec.tls` block      |
 * | no CronJob                         | renders `CronJob/cron-purge-trash`                 |
 * | no PVC; volumes are `emptyDir`     | renders `PersistentVolumeClaim/worker-uploads`     |
 * | no host anywhere in the plan       | renders `Ingress/web` with `hosts.primary`         |
 *
 * …followed by the proof §4.12's "Epic-owned name" clause depends on: **a normal render is
 * byte-identical** to what it rendered before this task — pinned twice, once as a deep equality
 * against the existing golden fixture and once as a SHA-256 over the serialised objects, so a change
 * of a single byte in a normal render fails a test that names this task.
 */
describe('T60 — a verification target’s plan (plan §4.12:649-652, ACC-06-48)', () => {
	/** WEB_WORKER_VOLUME + everything §4.12 forbids: a TLS mode, hosts, a cron, and a volume. */
	const verificationInput = (): AppRenderInput => {
		const draft = JSON.parse(JSON.stringify(fixture(WEB_WORKER_VOLUME))) as Json;
		draft.purpose = 'verification';
		draft.ttlMinutes = 30;
		draft.ref.namespace = 'ew-helpdesk-1a2b3c4d-v5e6f7a-1';
		draft.isFirstDeploymentOnCluster = true;
		return draft as unknown as AppRenderInput;
	};

	/** The same input, one field different: the target every other test in this file renders. */
	const deployInput = (): AppRenderInput => ({
		...verificationInput(),
		purpose: 'deploy',
		ttlMinutes: undefined
	});

	it('renders no Ingress, no TLS, no CronJob and no PVC — while a deploy ref renders all four', () => {
		const plan = planAppRender(verificationInput(), { now: '2026-09-18T10:00:00.000Z' });
		const kinds = plan.objects.map((object) => object.kind);

		expect(kinds).not.toContain('Ingress');
		expect(kinds).not.toContain('CronJob');
		expect(kinds).not.toContain('PersistentVolumeClaim');

		// No TLS block, and no object with a `tls` field at all — an Ingress is the only object that
		// carries one, and `ingress.tls` is `cert-manager` in this fixture.
		expect(verificationInput().ingress.tls).toBe('cert-manager');
		for (const object of plan.objects) {
			expect(asJson(object).spec?.tls).toBeUndefined();
		}
		// §4.12:651 — a CronJob is a §4.8 concern and `planAppJobs` owns it, so it is asked there.
		expect(planAppJobs(verificationInput(), {}).cronJobs).toHaveLength(0);

		// The control: the same input as a deploy ref renders each of them.
		const deployed = planAppRender(deployInput(), { now: '2026-09-18T10:00:00.000Z' });
		const deployedKinds = deployed.objects.map((object) => object.kind);
		expect(deployedKinds).toContain('Ingress');
		expect(deployedKinds).toContain('PersistentVolumeClaim');
		expect(planAppJobs(deployInput(), {}).cronJobs).toHaveLength(1);
		expect((objectNamed(deployed, 'Ingress', 'web') as Json).spec.tls).toMatchObject([
			{ hosts: ['helpdesk.example.com', 'support.example.com', 'old-helpdesk.example.com'] }
		]);
	});

	it('publishes no host rule anywhere — so no DNS record can be derived from the plan', () => {
		const plan = planAppRender(verificationInput(), { now: '2026-09-18T10:00:00.000Z' });
		const hosts = ['helpdesk.example.com', 'support.example.com', 'old-helpdesk.example.com'];

		const rulesOf = (objects: readonly AppRenderedObject[]): string[] =>
			objects
				.map((object) => asJson(object).spec?.rules)
				.filter(Boolean)
				.flatMap((rules: Json[]) => rules.map((rule) => rule.host));

		// The control first: with the same input as a deploy ref, all three hosts reach an Ingress.
		expect(rulesOf(planAppRender(deployInput(), {}).objects)).toEqual(hosts);

		// §4.12:651 — a verification renders no host-bearing object, which is what the agent side's
		// DNS record creation keys off.
		expect(rulesOf(plan.objects)).toEqual([]);
		expect(plan.objects.filter((object) => object.kind === 'Ingress')).toEqual([]);

		// Reported, not hidden: §4.7's platform ConfigMap still carries `EVER_WORKS_APP_HOST` derived
		// from `hosts.primary`. §4.12:651 forbids Ingress/TLS/CronJob/DNS/custom-domain/PVC
		// **objects** and says nothing about §4.7's values, so what a verification's ConfigMap holds
		// is decided by the render input APW-06 T22 builds — which must pass `hosts: { primary: null }`
		// for a verification (`primaryHost: null` is what this task's own env context passes).
		const platform = objectNamed(plan, 'ConfigMap', 'app-platform-b41d7e6c0a') as Json;
		expect(platform.data.EVER_WORKS_APP_HOST).toBe('helpdesk.example.com');
	});

	it('carries the purpose label and the caller’s expiry annotation, and nothing else on the namespace', () => {
		const input = verificationInput();
		const namespace = asJson(renderNamespace(input, { now: '2026-09-18T10:00:00.000Z' }));

		expect(namespace.metadata.name).toBe('ew-helpdesk-1a2b3c4d-v5e6f7a-1');
		expect(namespace.metadata.labels['ever-works.io/purpose']).toBe('verification');
		expect(namespace.metadata.annotations).toEqual({
			'ever-works.io/expires-at': '2026-09-18T10:30:00.000Z'
		});

		// §4.12:660 — a deploy namespace carries neither.
		const live = asJson(renderNamespace(deployInput(), { now: '2026-09-18T10:00:00.000Z' }));
		expect(live.metadata.labels['ever-works.io/purpose']).toBeUndefined();
		expect(live.metadata.annotations).toBeUndefined();
	});

	it('turns every declared volume into an emptyDir of the declared size, mounts unchanged', () => {
		const plan = planAppRender(verificationInput(), { now: '2026-09-18T10:00:00.000Z' });
		const worker = deploymentIn(plan, 'worker');

		expect(podSpecOf(worker).volumes).toContainEqual({ name: 'uploads', emptyDir: { sizeLimit: '5Gi' } });
		expect(containerOf(worker).volumeMounts).toContainEqual({
			name: 'uploads',
			mountPath: '/data/uploads'
		});
		// The control: the same volume is a claim for a deploy ref.
		const deployed = deploymentIn(planAppRender(deployInput(), {}), 'worker');
		expect(podSpecOf(deployed).volumes).toContainEqual({
			name: 'uploads',
			persistentVolumeClaim: { claimName: 'worker-uploads' }
		});
	});

	it('still renders the workloads, the Services and the secrets — a verification is not an empty plan', () => {
		const plan = planAppRender(verificationInput(), { now: '2026-09-18T10:00:00.000Z' });
		const names = plan.objects.map((object) => `${object.kind}/${object.metadata.name}`);

		expect(names).toEqual([
			'Namespace/ew-helpdesk-1a2b3c4d-v5e6f7a-1',
			'ServiceAccount/app',
			'LimitRange/ew-defaults',
			'NetworkPolicy/ew-default-deny',
			'NetworkPolicy/ew-allow-same-namespace',
			'NetworkPolicy/ew-allow-egress',
			'NetworkPolicy/ew-allow-ingress',
			'NetworkPolicy/ew-allow-deps',
			'Secret/app-env-b41d7e6c0a',
			'ConfigMap/app-platform-b41d7e6c0a',
			'Service/web',
			'Deployment/web',
			'Deployment/worker'
		]);

		// §4.12:651 — the pre-deploy and first-deploy Jobs, which `planAppJobs` owns, are rendered.
		const jobPlan = planAppJobs(verificationInput(), {});
		expect(jobPlan.jobs.map((job) => job.name)).toContain('migrate');
		expect(jobPlan.objects.every((object) => object.metadata.namespace === 'ew-helpdesk-1a2b3c4d-v5e6f7a-1')).toBe(
			true
		);
	});

	it('leaves a normal render byte-identical: golden deep-equality plus a SHA-256 over the bytes', () => {
		// The deep equality is the existing golden fixture's, restated here so the T60 claim is one
		// test; the hash is what catches a change `toEqual` would still consider equal.
		const singleWeb = JSON.parse(JSON.stringify(renderAppObjects(fixture(SINGLE_WEB))));
		expect(singleWeb).toEqual(golden('expected.single-web.objects.json'));

		const webWorkerVolume = JSON.parse(JSON.stringify(renderAppObjects(fixture(WEB_WORKER_VOLUME))));
		expect(webWorkerVolume).toEqual(golden('expected.web-worker-volume.objects.json'));

		expect(
			createHash('sha256')
				.update(JSON.stringify(renderAppObjects(fixture(SINGLE_WEB))))
				.digest('hex')
		).toBe('8524880f76f40bc6bff251e1fe5a887dcaa3b20a8adbbbdf5632fc3ed7f38d26');
		expect(
			createHash('sha256')
				.update(JSON.stringify(renderAppObjects(fixture(WEB_WORKER_VOLUME))))
				.digest('hex')
		).toBe('d04874375a7582a1f571c49b3f19d1a85b71667cb8ef76075105484b3185fc71');
	});
});
