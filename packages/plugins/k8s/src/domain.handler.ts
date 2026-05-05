import { promises as dnsPromises } from 'node:dns';
import type { AddDomainResult, DeploymentDomain, DeploymentDomainVerification } from '@ever-works/plugin';
import type { IngressStrategy } from './ingress/strategy.js';

const PROVIDER_TARGET_HINT = 'cluster ingress load balancer';

/**
 * Compute the DNS-record advice for a domain. Apex domains need an A record;
 * subdomains need a CNAME. Without an `ingressLbHost`, we still return
 * structured guidance with a placeholder value.
 */
export function buildDnsGuidance(domain: string, ingressLbHost?: string): readonly DeploymentDomainVerification[] {
	const isApex = !domain.includes('.') || domain.split('.').length === 2;
	if (isApex) {
		return [
			{
				type: 'A',
				domain,
				value: ingressLbHost ?? PROVIDER_TARGET_HINT,
				reason: 'Point your apex domain to the cluster ingress load balancer.'
			}
		];
	}
	return [
		{
			type: 'CNAME',
			domain,
			value: ingressLbHost ?? PROVIDER_TARGET_HINT,
			reason: 'Point your subdomain to the cluster ingress load balancer.'
		}
	];
}

/**
 * Patch an Ingress object so it serves a new host. Pure function — the
 * caller is responsible for applying the patched body via SSA.
 */
export function appendHostToIngress(
	ingress: { spec?: { rules?: unknown[]; tls?: unknown[]; ingressClassName?: string } },
	args: {
		host: string;
		serviceName: string;
		strategy: IngressStrategy;
		tlsIssuer?: string;
	}
): { spec: Record<string, unknown> } {
	const spec = (ingress.spec ?? {}) as {
		rules?: Array<{ host?: string; http?: unknown }>;
		tls?: Array<{ hosts?: string[]; secretName?: string }>;
		ingressClassName?: string;
	};

	const rules = [...(spec.rules ?? [])];
	if (!rules.some((rule) => rule.host === args.host)) {
		rules.push({
			host: args.host,
			http: {
				paths: [
					{
						path: '/',
						pathType: 'Prefix',
						backend: { service: { name: args.serviceName, port: { number: 80 } } }
					}
				]
			}
		});
	}

	const allHosts = rules.map((r) => r.host).filter((h): h is string => Boolean(h));
	const tls = args.strategy.tls({
		hosts: allHosts,
		tlsIssuer: args.tlsIssuer,
		className: spec.ingressClassName
	});

	const newSpec: Record<string, unknown> = {
		ingressClassName: spec.ingressClassName,
		rules
	};
	if (tls.length > 0) newSpec.tls = tls;
	return { spec: newSpec };
}

/**
 * Patch an Ingress object so a host is removed.
 */
export function removeHostFromIngress(
	ingress: { spec?: { rules?: unknown[]; tls?: unknown[]; ingressClassName?: string } },
	args: { host: string; strategy: IngressStrategy; tlsIssuer?: string }
): { spec: Record<string, unknown> } {
	const spec = (ingress.spec ?? {}) as {
		rules?: Array<{ host?: string; http?: unknown }>;
		tls?: Array<{ hosts?: string[]; secretName?: string }>;
		ingressClassName?: string;
	};

	const rules = (spec.rules ?? []).filter((rule) => rule.host !== args.host);
	const allHosts = rules.map((r) => r.host).filter((h): h is string => Boolean(h));
	const tls = args.strategy.tls({
		hosts: allHosts,
		tlsIssuer: args.tlsIssuer,
		className: spec.ingressClassName
	});

	const newSpec: Record<string, unknown> = {
		ingressClassName: spec.ingressClassName,
		rules
	};
	if (tls.length > 0) newSpec.tls = tls;
	return { spec: newSpec };
}

/**
 * Verify that a domain's DNS resolves to (or via) the expected target.
 * Default resolver is the Node DNS module; injectable for tests.
 */
export type DnsResolver = {
	resolveCname(host: string): Promise<string[]>;
	resolve4(host: string): Promise<string[]>;
};

export const defaultDnsResolver: DnsResolver = {
	resolveCname: (host) => dnsPromises.resolveCname(host),
	resolve4: (host) => dnsPromises.resolve4(host)
};

export async function verifyDomainResolution(
	domain: string,
	expectedTarget: string | undefined,
	resolver: DnsResolver = defaultDnsResolver
): Promise<DeploymentDomain> {
	const hostsTried: string[] = [];
	if (expectedTarget) hostsTried.push(expectedTarget.toLowerCase());

	let resolved = false;
	try {
		const cnames = (await resolver.resolveCname(domain)).map((c) => c.toLowerCase());
		if (expectedTarget) {
			resolved = cnames.includes(expectedTarget.toLowerCase());
		} else {
			resolved = cnames.length > 0;
		}
	} catch {
		// Fall through to A record lookup.
	}

	if (!resolved) {
		try {
			const a = await resolver.resolve4(domain);
			resolved = a.length > 0;
		} catch {
			resolved = false;
		}
	}

	return {
		name: domain,
		verified: resolved,
		verification: resolved ? undefined : buildDnsGuidance(domain, expectedTarget)
	};
}

/**
 * Wrap a `verifyDomainResolution` result into the AddDomainResult shape.
 */
export function toAddDomainResult(domain: DeploymentDomain): AddDomainResult {
	return { domain, verified: domain.verified };
}
