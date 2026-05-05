import type { IngressStrategy, IngressStrategyInputs, IngressTlsEntry } from './strategy.js';

/**
 * Fallback strategy used when no built-in strategy matches the cluster's
 * IngressClass controller. Emits a vanilla Ingress with cert-manager
 * annotations (which are widely supported) and no controller-specific
 * extras.
 */
export class GenericIngressStrategy implements IngressStrategy {
	readonly controller = '';

	annotations(input: IngressStrategyInputs): Record<string, string> {
		const annotations: Record<string, string> = {};
		if (input.tlsIssuer) {
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
