/**
 * EW-742 P2.2 T17 — per-provider credential field schemas used by the
 * schema-driven tenant credentials form.
 *
 * These mirror each plugin package's `settingsSchema` (BullMQ /
 * pg-boss / Temporal / Inngest — Trigger.dev intentionally has no
 * tenant-supplied credentials, so its entry is empty). We hard-code
 * the field list in the web app rather than fetching the plugin's
 * schema at runtime because:
 *
 *   1. The web app doesn't import `@ever-works/job-runtime-*-plugin`
 *      packages — that would pull bullmq/pg-boss/@temporalio/inngest
 *      transitive deps into the browser bundle for no runtime gain.
 *   2. The plugin manifests already act as the contract source —
 *      these definitions sit alongside them as the UI projection
 *      and the operator-wiring docs (providers.md) document the
 *      credential bag shape verbatim.
 *
 * Each field declares:
 *   - `name`: the key in the credentials JSON object posted to the
 *     server (matches the plugin's settingsSchema.properties.<name>)
 *   - `label`: human-readable label
 *   - `description`: helper text shown under the field
 *   - `secret`: render as masked password input (true) or plain text (false)
 *   - `required`: client-side validation on save
 *   - `envVar`: documentation hint shown next to the field for
 *     operators who prefer the env-var fallback
 *   - `placeholder`: input placeholder
 *   - `multiline`: render as <textarea> (true) — used for PEM-encoded
 *     mTLS cert/key pairs
 */
import type { TenantJobRuntimeProviderId } from '@/lib/api/tenant-job-runtime';

export interface JobRuntimeCredentialField {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly secret: boolean;
	readonly required: boolean;
	readonly envVar?: string;
	readonly placeholder?: string;
	readonly multiline?: boolean;
}

export const JOB_RUNTIME_CREDENTIAL_SCHEMAS: Record<TenantJobRuntimeProviderId, readonly JobRuntimeCredentialField[]> = {
	trigger: [],
	bullmq: [
		{
			name: 'redisUrl',
			label: 'Redis URL',
			description: 'BullMQ Redis connection string. Required for byo/override modes.',
			secret: true,
			required: true,
			envVar: 'BULLMQ_REDIS_URL',
			placeholder: 'redis://default:password@host:6379'
		},
		{
			name: 'queuePrefix',
			label: 'Queue prefix',
			description:
				'Per-tenant Redis key prefix for queue isolation. Falls back to a tenant-derived default when blank.',
			secret: false,
			required: false,
			envVar: 'BULLMQ_QUEUE_PREFIX',
			placeholder: 'tenant-acme'
		}
	],
	pgboss: [
		{
			name: 'connectionString',
			label: 'Postgres connection string',
			description: 'pg-boss connection string. Required for byo/override modes.',
			secret: true,
			required: true,
			envVar: 'PGBOSS_CONNECTION_STRING',
			placeholder: 'postgres://user:password@host:5432/db'
		},
		{
			name: 'schema',
			label: 'pg-boss schema',
			description:
				'Per-tenant Postgres schema for queue isolation (ADR-017 Q2). Falls back to instance default when blank.',
			secret: false,
			required: false,
			envVar: 'PGBOSS_SCHEMA',
			placeholder: 'tenant_acme'
		}
	],
	temporal: [
		{
			name: 'namespace',
			label: 'Temporal namespace',
			description: 'Per-tenant Temporal namespace (ADR-017 Q1 namespace-per-tenant).',
			secret: false,
			required: true,
			envVar: 'TEMPORAL_NAMESPACE',
			placeholder: 'tenant-acme'
		},
		{
			name: 'address',
			label: 'Temporal address',
			description: 'gRPC endpoint for the tenant\'s Temporal cluster.',
			secret: false,
			required: false,
			envVar: 'TEMPORAL_ADDRESS',
			placeholder: 'temporal.tenant-acme.svc:7233'
		},
		{
			name: 'tlsCert',
			label: 'TLS client certificate (PEM)',
			description: 'mTLS client cert for connecting to a tenant cluster. Paste the full PEM block.',
			secret: true,
			required: false,
			envVar: 'TEMPORAL_TLS_CERT',
			multiline: true,
			placeholder: '-----BEGIN CERTIFICATE-----\n...'
		},
		{
			name: 'tlsKey',
			label: 'TLS client key (PEM)',
			description: 'mTLS client key paired with the cert above.',
			secret: true,
			required: false,
			envVar: 'TEMPORAL_TLS_KEY',
			multiline: true,
			placeholder: '-----BEGIN PRIVATE KEY-----\n...'
		}
	],
	inngest: [
		{
			name: 'eventKey',
			label: 'Inngest event key',
			description: 'Used by `inngest.send()` to publish events to the tenant\'s Inngest project. SaaS only.',
			secret: true,
			required: true,
			envVar: 'INNGEST_EVENT_KEY'
		},
		{
			name: 'signingKey',
			label: 'Inngest signing key',
			description: 'Used to verify inbound webhook requests from Inngest. SaaS only.',
			secret: true,
			required: true,
			envVar: 'INNGEST_SIGNING_KEY'
		}
	]
};

/**
 * Trigger.dev doesn't expose tenant-overlay credentials through the
 * tenant form — operators must point per-tenant Trigger.dev project
 * access tokens at the platform via operator-side config (per
 * `providers.md` § Trigger.dev "BYO project switching" deferral).
 */
export const PROVIDERS_WITHOUT_CREDENTIALS: ReadonlySet<TenantJobRuntimeProviderId> = new Set(['trigger']);
