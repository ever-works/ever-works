import { describe, it, expect } from 'vitest';
import { NginxIngressStrategy } from '../ingress/nginx.strategy';
import { TraefikIngressStrategy } from '../ingress/traefik.strategy';
import { GenericIngressStrategy } from '../ingress/generic.strategy';
import { IngressStrategyRegistry } from '../ingress/strategy.registry';

describe('NginxIngressStrategy', () => {
	const s = new NginxIngressStrategy();

	it('claims the ingress-nginx controller', () => {
		expect(s.controller).toBe('k8s.io/ingress-nginx');
	});

	it('emits SSL-redirect annotations only when tlsIssuer is set', () => {
		expect(s.annotations({ hosts: ['x.com'] })['nginx.ingress.kubernetes.io/ssl-redirect']).toBe('false');
		expect(
			s.annotations({ hosts: ['x.com'], tlsIssuer: 'letsencrypt-prod' })[
				'nginx.ingress.kubernetes.io/ssl-redirect'
			]
		).toBe('true');
	});

	it('adds cert-manager annotation only when tlsIssuer is set', () => {
		expect(s.annotations({ hosts: ['x.com'] })['cert-manager.io/cluster-issuer']).toBeUndefined();
		expect(
			s.annotations({ hosts: ['x.com'], tlsIssuer: 'letsencrypt-prod' })['cert-manager.io/cluster-issuer']
		).toBe('letsencrypt-prod');
	});

	it('produces a TLS entry only when tlsIssuer + hosts are present', () => {
		expect(s.tls({ hosts: [] })).toEqual([]);
		expect(s.tls({ hosts: ['x.com'] })).toEqual([]);
		expect(s.tls({ hosts: ['x.com'], tlsIssuer: 'le' })).toEqual([{ hosts: ['x.com'], secretName: 'x-com-tls' }]);
	});
});

describe('TraefikIngressStrategy', () => {
	const s = new TraefikIngressStrategy();

	it('claims the Traefik controller', () => {
		expect(s.controller).toBe('traefik.io/ingress-controller');
	});

	it('uses websecure entrypoint with TLS, web without', () => {
		expect(s.annotations({ hosts: ['x.com'] })['traefik.ingress.kubernetes.io/router.entrypoints']).toBe('web');
		expect(
			s.annotations({ hosts: ['x.com'], tlsIssuer: 'le' })['traefik.ingress.kubernetes.io/router.entrypoints']
		).toBe('websecure');
		expect(s.annotations({ hosts: ['x.com'], tlsIssuer: 'le' })['traefik.ingress.kubernetes.io/router.tls']).toBe(
			'true'
		);
	});
});

describe('GenericIngressStrategy', () => {
	const s = new GenericIngressStrategy();

	it('uses an empty controller string (matches the fallback)', () => {
		expect(s.controller).toBe('');
	});

	it('emits no controller-specific annotations', () => {
		expect(Object.keys(s.annotations({ hosts: ['x.com'] }))).toHaveLength(0);
	});

	it('still adds cert-manager annotation when tlsIssuer is set', () => {
		expect(s.annotations({ hosts: ['x.com'], tlsIssuer: 'le' })['cert-manager.io/cluster-issuer']).toBe('le');
	});
});

describe('IngressStrategyRegistry', () => {
	it('ships with nginx + traefik registered and a generic fallback', () => {
		const r = new IngressStrategyRegistry();
		expect(r.hasStrategyFor('k8s.io/ingress-nginx')).toBe(true);
		expect(r.hasStrategyFor('traefik.io/ingress-controller')).toBe(true);
		expect(r.hasStrategyFor('haproxy.io/ingress-controller')).toBe(false);
	});

	it('selectStrategy returns the matching strategy when known', () => {
		const r = new IngressStrategyRegistry();
		expect(r.selectStrategy('k8s.io/ingress-nginx')).toBeInstanceOf(NginxIngressStrategy);
		expect(r.selectStrategy('traefik.io/ingress-controller')).toBeInstanceOf(TraefikIngressStrategy);
	});

	it('selectStrategy falls back to generic for unknown controllers and undefined', () => {
		const r = new IngressStrategyRegistry();
		expect(r.selectStrategy('something.io/unknown')).toBeInstanceOf(GenericIngressStrategy);
		expect(r.selectStrategy(undefined)).toBeInstanceOf(GenericIngressStrategy);
	});

	it('lets callers register additional strategies', () => {
		const r = new IngressStrategyRegistry();
		class HaProxyStrategy extends GenericIngressStrategy {
			override readonly controller = 'haproxy.io/ingress-controller';
		}
		r.register(new HaProxyStrategy());
		expect(r.hasStrategyFor('haproxy.io/ingress-controller')).toBe(true);
		expect(r.selectStrategy('haproxy.io/ingress-controller')).toBeInstanceOf(HaProxyStrategy);
	});
});
