import type { JsonSchema } from '@ever-works/plugin';

/**
 * EW-738 — JSON Schema for the `@ever-works/cloudflare-dns` plugin
 * settings. Matches the authoritative definition in
 * `docs/specs/features/cloudflare-dns-plugin/spec.md` §4.2.
 *
 * The plugin supports two operator modes (G4 in the spec):
 *
 *   - **Managed** — the platform's own zone (`ever.works`). Operators set
 *     `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, and
 *     `EVER_WORKS_DEPLOY_LB_HOSTNAME` via env vars at the platform tier and
 *     no user-visible settings UI is exposed for them.
 *   - **Bring-your-own** — a user supplies their own Cloudflare token + zone
 *     for a custom apex/domain. Values are persisted to encrypted plugin
 *     settings (`x-secret` + `x-scope: 'user'`).
 *
 * `x-envVar` fallbacks let the plugin keep working in dev environments that
 * still wire credentials via the `CLOUDFLARE_*` / `EVER_WORKS_*` env vars
 * the legacy `CloudflareDnsProvider` reads today — the resolver in
 * `PluginContext.getResolvedSettings` will pick them up automatically.
 */
export const cloudflareDnsSettingsSchema: JsonSchema = {
	type: 'object',
	properties: {
		apiToken: {
			type: 'string',
			title: 'Cloudflare API token',
			description:
				'Scoped Cloudflare API token with DNS:Edit on the target zone. Create one at https://dash.cloudflare.com/profile/api-tokens.',
			'x-secret': true,
			'x-envVar': 'CLOUDFLARE_API_TOKEN',
			'x-scope': 'user'
		},
		zoneId: {
			type: 'string',
			title: 'Cloudflare zone id',
			description: 'The Cloudflare zone id that owns the root domain.',
			'x-envVar': 'CLOUDFLARE_ZONE_ID',
			'x-scope': 'user'
		},
		rootDomain: {
			type: 'string',
			title: 'Root domain',
			description: 'The DNS zone managed by this provider, e.g. ever.works.',
			default: 'ever.works',
			'x-envVar': 'EVER_WORKS_DOMAIN'
		},
		targetHostname: {
			type: 'string',
			title: 'Ingress LB hostname',
			description:
				'CNAME target — the load balancer hostname that public Work subdomains should resolve to. Admin-only for the managed mode.',
			'x-envVar': 'EVER_WORKS_DEPLOY_LB_HOSTNAME',
			'x-adminOnly': true
		},
		proxied: {
			type: 'boolean',
			title: 'Cloudflare proxy',
			description:
				'Whether new records are created behind the Cloudflare orange-cloud proxy (recommended for managed *.ever.works records — gives Universal SSL out of the box). Set to false for custom-domain records the user already serves TLS for.',
			default: true
		}
	},
	required: ['apiToken', 'zoneId']
};

export interface CloudflareDnsSettings {
	apiToken: string;
	zoneId: string;
	rootDomain: string;
	targetHostname: string;
	proxied: boolean;
}
