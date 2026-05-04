/**
 * Public request shape for POST /api/register-work and the equivalent
 * register_work MCP tool. The GitHub credential is NOT part of this body —
 * it travels in the X-GitHub-Token header (REST) or as a sibling tool
 * argument that is redacted from logs (MCP).
 */
export interface RegisterWorkRequest {
	/** HTTPS GitHub repo URL containing works.yml at root. */
	repo: string;

	/** Optional contact email. */
	email?: string;

	/** Optional opaque agent identifier (printable ASCII, ≤256 chars). */
	agentId?: string;

	/** Optional HTTPS URL for signed terminal-status webhooks. */
	webhookUrl?: string;

	/** Optional DNS-safe slug for the assigned subdomain. */
	subdomain?: string;

	/**
	 * Reserved for v2 paid plane — accepts x402, Skyfire, Crossmint, or
	 * Stripe Agent payment envelopes. Ignored at v1.
	 */
	agentPayment?: Record<string, unknown>;
}

/**
 * Item-source variants understood by the manifest at v1. Mirrors the YAML
 * shape documented in docs/specs/features/agent-zero-friction-onboarding/manifest-schema.md.
 */
export type OnboardingRequestSource =
	| OnboardingRequestSourceAwesomeReadme
	| OnboardingRequestSourceWebSearch
	| OnboardingRequestSourceDataRepo
	| OnboardingRequestSourceInline;

export interface OnboardingRequestSourceAwesomeReadme {
	type: 'awesome-readme';
	url: string;
	expansionFactor?: number;
}

export interface OnboardingRequestSourceWebSearch {
	type: 'web-search';
	query: string;
	max?: number;
}

export interface OnboardingRequestSourceDataRepo {
	type: 'data-repo';
	url: string;
	mode?: 'copy' | 'link';
}

export interface OnboardingRequestSourceInline {
	type: 'inline';
	items: ReadonlyArray<{
		name: string;
		url?: string;
		categories?: ReadonlyArray<string>;
		tags?: ReadonlyArray<string>;
		description?: string;
	}>;
}
