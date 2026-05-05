import { describe, it, expect } from 'vitest';
import {
	appendHostToIngress,
	buildDnsGuidance,
	removeHostFromIngress,
	verifyDomainResolution,
	type DnsResolver,
} from '../domain.handler';
import { NginxIngressStrategy } from '../ingress/nginx.strategy';
import { GenericIngressStrategy } from '../ingress/generic.strategy';

describe('buildDnsGuidance', () => {
	it('suggests an A record for apex domains', () => {
		const g = buildDnsGuidance('example.com', '203.0.113.10');
		expect(g[0].type).toBe('A');
		expect(g[0].value).toBe('203.0.113.10');
	});

	it('suggests a CNAME for subdomains', () => {
		const g = buildDnsGuidance('blog.example.com', 'lb.cluster.example.com');
		expect(g[0].type).toBe('CNAME');
		expect(g[0].value).toBe('lb.cluster.example.com');
	});

	it('falls back to a placeholder hint when no target is known', () => {
		const g = buildDnsGuidance('foo.example.com', undefined);
		expect(g[0].value).toMatch(/cluster ingress load balancer/i);
	});
});

describe('appendHostToIngress', () => {
	it('appends a new host as a rule', () => {
		const ingress = { spec: { ingressClassName: 'nginx', rules: [], tls: [] } };
		const out = appendHostToIngress(ingress, {
			host: 'tools.example.com',
			serviceName: 'my-site',
			strategy: new NginxIngressStrategy(),
			tlsIssuer: 'letsencrypt-prod',
		});
		const rules = (out.spec.rules as Array<{ host: string }>) ?? [];
		expect(rules[0].host).toBe('tools.example.com');
		expect(out.spec.tls).toBeDefined();
	});

	it('does not duplicate when the host already exists', () => {
		const ingress = {
			spec: {
				ingressClassName: 'nginx',
				rules: [{ host: 'a.example.com' }],
				tls: [],
			},
		};
		const out = appendHostToIngress(ingress, {
			host: 'a.example.com',
			serviceName: 's',
			strategy: new NginxIngressStrategy(),
		});
		expect((out.spec.rules as unknown[]).length).toBe(1);
	});

	it('omits TLS when no issuer is set', () => {
		const out = appendHostToIngress({ spec: { rules: [], tls: [] } }, {
			host: 'a.example.com',
			serviceName: 's',
			strategy: new GenericIngressStrategy(),
		});
		expect(out.spec.tls).toBeUndefined();
	});
});

describe('removeHostFromIngress', () => {
	it('removes the matching host', () => {
		const ingress = {
			spec: {
				rules: [{ host: 'a.example.com' }, { host: 'b.example.com' }],
				tls: [],
			},
		};
		const out = removeHostFromIngress(ingress, {
			host: 'a.example.com',
			strategy: new GenericIngressStrategy(),
		});
		const rules = (out.spec.rules as Array<{ host: string }>) ?? [];
		expect(rules.map((r) => r.host)).toEqual(['b.example.com']);
	});
});

describe('verifyDomainResolution', () => {
	const ok: DnsResolver = {
		resolveCname: async () => ['lb.cluster.example.com'],
		resolve4: async () => [],
	};
	const noCnameButA: DnsResolver = {
		resolveCname: async () => {
			throw new Error('ENOTFOUND');
		},
		resolve4: async () => ['203.0.113.10'],
	};
	const fail: DnsResolver = {
		resolveCname: async () => {
			throw new Error('ENOTFOUND');
		},
		resolve4: async () => {
			throw new Error('ENOTFOUND');
		},
	};

	it('returns verified=true when CNAME points at the expected target', async () => {
		const r = await verifyDomainResolution('blog.example.com', 'lb.cluster.example.com', ok);
		expect(r.verified).toBe(true);
	});

	it('returns verified=true when an A record exists (no expected target)', async () => {
		const r = await verifyDomainResolution('example.com', undefined, noCnameButA);
		expect(r.verified).toBe(true);
	});

	it('returns verified=false with DNS guidance when nothing resolves', async () => {
		const r = await verifyDomainResolution('blog.example.com', 'lb.example.com', fail);
		expect(r.verified).toBe(false);
		expect(r.verification?.[0].type).toBe('CNAME');
	});
});
