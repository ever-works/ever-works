import type { IngressStrategy } from './ingress/strategy.js';
import type { ManifestRenderInputs } from './types.js';

/**
 * Field manager used by server-side apply. Editing this string is a
 * breaking change for users who SSA-conflict on hand-edited fields.
 */
export const FIELD_MANAGER = 'ever-works-k8s-plugin';

const COMMON_LABELS = (workId: string, slug: string): Record<string, string> => ({
	'ever-works.io/managed': 'true',
	'ever-works.io/work-id': workId,
	'app.kubernetes.io/name': slug,
	'app.kubernetes.io/managed-by': FIELD_MANAGER
});

const SELECTOR_LABELS = (slug: string): Record<string, string> => ({
	'app.kubernetes.io/name': slug
});

/**
 * Build the Deployment manifest for a work.
 */
export function buildDeployment(input: ManifestRenderInputs): Record<string, unknown> {
	const labels = COMMON_LABELS(input.workId, input.workSlug);
	const selector = SELECTOR_LABELS(input.workSlug);

	const podSpec: Record<string, unknown> = {
		containers: [
			{
				name: 'app',
				image: input.image,
				imagePullPolicy: 'IfNotPresent',
				ports: [{ containerPort: input.containerPort, name: 'http' }],
				readinessProbe: {
					httpGet: { path: '/', port: 'http' },
					periodSeconds: 5,
					initialDelaySeconds: 5
				},
				livenessProbe: {
					httpGet: { path: '/', port: 'http' },
					periodSeconds: 10,
					initialDelaySeconds: 30
				},
				resources: {
					requests: { cpu: '100m', memory: '128Mi' },
					limits: { cpu: '500m', memory: '512Mi' }
				},
				// Server-side deploys (EW — platform-managed clusters) mount the
				// per-work runtime-env Secret the platform applied just before
				// this manifest. `optional: true` keeps the pod schedulable when
				// the Secret is absent (older works, custom clusters) — the app
				// then boots on its baked-in defaults exactly as before.
				...(input.envFromSecretName
					? {
							envFrom: [{ secretRef: { name: input.envFromSecretName, optional: true } }]
						}
					: {})
			}
		]
	};

	if (input.pullSecretName) {
		podSpec.imagePullSecrets = [{ name: input.pullSecretName }];
	}

	return {
		apiVersion: 'apps/v1',
		kind: 'Deployment',
		metadata: { name: input.workSlug, namespace: input.namespace, labels },
		spec: {
			replicas: input.replicas,
			selector: { matchLabels: selector },
			strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
			template: {
				metadata: { labels: { ...selector, ...labels } },
				spec: podSpec
			}
		}
	};
}

/**
 * Build the per-work runtime-env Secret the app container `envFrom`s.
 *
 * Server-side (platform-managed) deploys only: the platform assembles the
 * runtime environment it used to push as GitHub Actions secrets and applies
 * it directly to the target namespace instead — no cluster credential and no
 * runtime value ever lands in the website repo. `stringData` so the values
 * are written verbatim (the API server base64-encodes on persist).
 */
export function buildRuntimeEnvSecret(input: {
	name: string;
	namespace: string;
	workId: string;
	workSlug: string;
	env: Record<string, string>;
}): Record<string, unknown> {
	return {
		apiVersion: 'v1',
		kind: 'Secret',
		metadata: {
			name: input.name,
			namespace: input.namespace,
			labels: COMMON_LABELS(input.workId, input.workSlug)
		},
		type: 'Opaque',
		stringData: input.env
	};
}

/**
 * Build the Service manifest. Always ClusterIP on port 80 → containerPort.
 */
export function buildService(input: ManifestRenderInputs): Record<string, unknown> {
	const labels = COMMON_LABELS(input.workId, input.workSlug);
	const selector = SELECTOR_LABELS(input.workSlug);
	return {
		apiVersion: 'v1',
		kind: 'Service',
		metadata: { name: input.workSlug, namespace: input.namespace, labels },
		spec: {
			type: 'ClusterIP',
			selector,
			ports: [{ name: 'http', port: 80, targetPort: input.containerPort, protocol: 'TCP' }]
		}
	};
}

/**
 * Build the Ingress manifest. Returns `null` when no hosts are configured.
 */
export function buildIngress(input: ManifestRenderInputs, strategy: IngressStrategy): Record<string, unknown> | null {
	if (input.hosts.length === 0) return null;

	const labels = COMMON_LABELS(input.workId, input.workSlug);
	const annotations = strategy.annotations({
		hosts: input.hosts,
		tlsIssuer: input.tlsIssuer,
		className: input.ingressClass
	});
	const tls = strategy.tls({
		hosts: input.hosts,
		tlsIssuer: input.tlsIssuer,
		className: input.ingressClass
	});

	const spec: Record<string, unknown> = {
		ingressClassName: input.ingressClass,
		rules: input.hosts.map((host) => ({
			host,
			http: {
				paths: [
					{
						path: '/',
						pathType: 'Prefix',
						backend: {
							service: { name: input.workSlug, port: { number: 80 } }
						}
					}
				]
			}
		}))
	};

	if (tls.length > 0) {
		spec.tls = tls;
	}

	return {
		apiVersion: 'networking.k8s.io/v1',
		kind: 'Ingress',
		metadata: {
			name: input.workSlug,
			namespace: input.namespace,
			labels,
			annotations
		},
		spec
	};
}

/**
 * Build a `kubernetes.io/dockerconfigjson` Secret used as imagePullSecret.
 */
export function buildImagePullSecret(args: {
	name: string;
	namespace: string;
	server: string;
	username: string;
	password: string;
	workId: string;
	workSlug: string;
}): Record<string, unknown> {
	const auth = Buffer.from(`${args.username}:${args.password}`).toString('base64');
	const dockerConfig = {
		auths: {
			[args.server]: {
				username: args.username,
				password: args.password,
				auth
			}
		}
	};
	const dockerConfigJson = Buffer.from(JSON.stringify(dockerConfig)).toString('base64');

	return {
		apiVersion: 'v1',
		kind: 'Secret',
		type: 'kubernetes.io/dockerconfigjson',
		metadata: {
			name: args.name,
			namespace: args.namespace,
			labels: COMMON_LABELS(args.workId, args.workSlug)
		},
		data: {
			'.dockerconfigjson': dockerConfigJson
		}
	};
}

/**
 * Conventional pull-secret name for a work.
 */
export function pullSecretNameFor(workSlug: string): string {
	return `${workSlug}-pull`;
}
