/**
 * Strategy interface for Kubernetes Ingress controllers.
 *
 * Strategies own controller-specific annotations and TLS handling. The
 * manifest renderer queries the active strategy without knowing whether
 * it's nginx, Traefik, or anything else.
 */
export interface IngressStrategyInputs {
	hosts: string[];
	tlsIssuer?: string;
	className?: string;
}

export interface IngressTlsEntry {
	hosts: string[];
	secretName: string;
}

export interface IngressStrategy {
	/**
	 * The `IngressClass.spec.controller` value this strategy claims.
	 * E.g. `k8s.io/ingress-nginx`, `traefik.io/ingress-controller`.
	 *
	 * The generic fallback uses an empty string and is selected only when
	 * no other strategy matches.
	 */
	readonly controller: string;

	annotations(input: IngressStrategyInputs): Record<string, string>;
	tls(input: IngressStrategyInputs): IngressTlsEntry[];
}
