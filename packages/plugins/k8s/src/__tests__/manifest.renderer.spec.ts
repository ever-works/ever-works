import { describe, it, expect } from 'vitest';
import {
	buildDeployment,
	buildIngress,
	buildImagePullSecret,
	buildService,
	pullSecretNameFor,
	FIELD_MANAGER,
} from '../manifest.renderer';
import { GenericIngressStrategy } from '../ingress/generic.strategy';
import { NginxIngressStrategy } from '../ingress/nginx.strategy';
import type { ManifestRenderInputs } from '../types';

const baseInput: ManifestRenderInputs = {
	workId: 'work-123',
	workSlug: 'my-site',
	namespace: 'ever-works',
	image: 'ghcr.io/acme/my-site:abc1234',
	replicas: 2,
	containerPort: 3000,
	hosts: [],
};

describe('buildDeployment', () => {
	it('produces a typed Deployment with selectors and labels', () => {
		const d = buildDeployment(baseInput) as Record<string, any>;
		expect(d.apiVersion).toBe('apps/v1');
		expect(d.kind).toBe('Deployment');
		expect(d.metadata.namespace).toBe('ever-works');
		expect(d.metadata.labels['ever-works.io/managed']).toBe('true');
		expect(d.metadata.labels['ever-works.io/work-id']).toBe('work-123');
		expect(d.metadata.labels['app.kubernetes.io/managed-by']).toBe(FIELD_MANAGER);
		expect(d.spec.replicas).toBe(2);
		expect(d.spec.selector.matchLabels['app.kubernetes.io/name']).toBe('my-site');
		expect(d.spec.strategy.type).toBe('RollingUpdate');
		const c = d.spec.template.spec.containers[0];
		expect(c.image).toBe(baseInput.image);
		expect(c.ports[0].containerPort).toBe(3000);
		expect(c.readinessProbe).toBeDefined();
	});

	it('omits imagePullSecrets when no pull secret name is provided', () => {
		const d = buildDeployment(baseInput) as Record<string, any>;
		expect(d.spec.template.spec.imagePullSecrets).toBeUndefined();
	});

	it('attaches imagePullSecrets when a pull secret name is provided', () => {
		const d = buildDeployment({ ...baseInput, pullSecretName: 'my-site-pull' }) as Record<string, any>;
		expect(d.spec.template.spec.imagePullSecrets).toEqual([{ name: 'my-site-pull' }]);
	});
});

describe('buildService', () => {
	it('returns a ClusterIP service on port 80 → containerPort', () => {
		const s = buildService(baseInput) as Record<string, any>;
		expect(s.apiVersion).toBe('v1');
		expect(s.kind).toBe('Service');
		expect(s.spec.type).toBe('ClusterIP');
		expect(s.spec.ports[0].port).toBe(80);
		expect(s.spec.ports[0].targetPort).toBe(3000);
		expect(s.spec.selector['app.kubernetes.io/name']).toBe('my-site');
	});
});

describe('buildIngress', () => {
	it('returns null when there are no hosts', () => {
		expect(buildIngress(baseInput, new GenericIngressStrategy())).toBeNull();
	});

	it('emits an Ingress with the strategy annotations', () => {
		const ing = buildIngress(
			{ ...baseInput, hosts: ['example.com'], ingressClass: 'nginx', tlsIssuer: 'letsencrypt-prod' },
			new NginxIngressStrategy(),
		) as Record<string, any>;
		expect(ing).not.toBeNull();
		expect(ing.apiVersion).toBe('networking.k8s.io/v1');
		expect(ing.metadata.annotations['nginx.ingress.kubernetes.io/ssl-redirect']).toBe('true');
		expect(ing.metadata.annotations['cert-manager.io/cluster-issuer']).toBe('letsencrypt-prod');
		expect(ing.spec.ingressClassName).toBe('nginx');
		expect(ing.spec.rules[0].host).toBe('example.com');
		expect(ing.spec.tls[0].hosts).toEqual(['example.com']);
	});

	it('omits the tls block when there is no tlsIssuer', () => {
		const ing = buildIngress(
			{ ...baseInput, hosts: ['example.com'], ingressClass: 'nginx' },
			new NginxIngressStrategy(),
		) as Record<string, any>;
		expect(ing.spec.tls).toBeUndefined();
	});
});

describe('buildImagePullSecret', () => {
	it('produces a dockerconfigjson Secret with correct base64-encoded auth', () => {
		const sec = buildImagePullSecret({
			name: 'pull',
			namespace: 'ever-works',
			server: 'ghcr.io',
			username: 'acme',
			password: 'p@ss',
			workId: 'w',
			workSlug: 'my-site',
		}) as Record<string, any>;
		expect(sec.type).toBe('kubernetes.io/dockerconfigjson');
		const decoded = JSON.parse(
			Buffer.from(sec.data['.dockerconfigjson'], 'base64').toString('utf-8'),
		);
		expect(decoded.auths['ghcr.io'].username).toBe('acme');
		expect(decoded.auths['ghcr.io'].password).toBe('p@ss');
		const auth = Buffer.from(decoded.auths['ghcr.io'].auth, 'base64').toString('utf-8');
		expect(auth).toBe('acme:p@ss');
	});
});

describe('pullSecretNameFor', () => {
	it('appends -pull to the slug', () => {
		expect(pullSecretNameFor('my-site')).toBe('my-site-pull');
	});
});
