import type { IngressStrategy, IngressStrategyInputs, IngressTlsEntry } from './strategy.js';

export class TraefikIngressStrategy implements IngressStrategy {
	readonly controller = 'traefik.io/ingress-controller';

	annotations(input: IngressStrategyInputs): Record<string, string> {
		const annotations: Record<string, string> = {
			'traefik.ingress.kubernetes.io/router.entrypoints': input.tlsIssuer
				? 'websecure'
				: 'web',
		};
		if (input.tlsIssuer) {
			annotations['traefik.ingress.kubernetes.io/router.tls'] = 'true';
			annotations['cert-manager.io/cluster-issuer'] = input.tlsIssuer;
		}
		return annotations;
	}

	tls(input: IngressStrategyInputs): IngressTlsEntry[] {
		if (!input.tlsIssuer || input.hosts.length === 0) {
			return [];
		}
		const primary = input.hosts[0]?.replace(/[^a-z0-9]/gi, '-').toLowerCase() ?? 'tls';
		return [{ hosts: [...input.hosts], secretName: `${primary}-tls` }];
	}
}
