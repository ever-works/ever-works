import type { IngressStrategy, IngressStrategyInputs, IngressTlsEntry } from './strategy.js';

export class NginxIngressStrategy implements IngressStrategy {
	readonly controller = 'k8s.io/ingress-nginx';

	annotations(input: IngressStrategyInputs): Record<string, string> {
		const annotations: Record<string, string> = {
			'nginx.ingress.kubernetes.io/proxy-body-size': '10m',
			'nginx.ingress.kubernetes.io/ssl-redirect': input.tlsIssuer ? 'true' : 'false',
		};
		if (input.tlsIssuer) {
			annotations['cert-manager.io/cluster-issuer'] = input.tlsIssuer;
		}
		return annotations;
	}

	tls(input: IngressStrategyInputs): IngressTlsEntry[] {
		if (!input.tlsIssuer || input.hosts.length === 0) {
			return [];
		}
		return [
			{
				hosts: [...input.hosts],
				secretName: tlsSecretName(input.hosts),
			},
		];
	}
}

function tlsSecretName(hosts: string[]): string {
	const primary = hosts[0]?.replace(/[^a-z0-9]/gi, '-').toLowerCase() ?? 'tls';
	return `${primary}-tls`;
}
