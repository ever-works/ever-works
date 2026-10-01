import type { IngressStrategy, IngressStrategyInputs, IngressTlsEntry } from './strategy.js';

/**
 * Fallback strategy used when no built-in strategy matches the cluster's
 * IngressClass controller. Emits a vanilla Ingress with cert-manager
 * annotations (which are widely supported) and no controller-specific
 * extras.
 */
export class GenericIngressStrategy implements IngressStrategy {
	/**
	 * The empty string is the fallback's marker: it matches only when no other
	 * strategy claims the cluster's controller.
	 *
	 * ⚠️ Annotated `string` on purpose. Without the annotation TypeScript infers the
	 * LITERAL `''`, and then a subclass cannot override it with a real controller
	 * name — `class HaProxyStrategy extends GenericIngressStrategy { override
	 * readonly controller = 'haproxy.io/ingress-controller' }` is `TS2416`,
	 * "Property 'controller' in type 'HaProxyStrategy' is not assignable to the same
	 * property in base type". `src/__tests__/ingress.spec.ts` documents the intended
	 * use ("lets callers register additional strategies") and the interface already
	 * declares `readonly controller: string`, so the narrow inference was the bug.
	 * Found by enabling spec type-checking (`tsconfig.specs.json`), which this package
	 * previously did not do.
	 */
	readonly controller: string = '';

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
