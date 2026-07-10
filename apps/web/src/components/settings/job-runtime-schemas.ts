/**
 * EW-742 P2.2 T17 — per-provider credential field schemas used by the
 * schema-driven tenant credentials form.
 *
 * These mirror each plugin package's `settingsSchema` (BullMQ /
 * pg-boss / Temporal / Inngest / Trigger.dev). We hard-code the field
 * list in the web app rather than fetching the plugin's schema at
 * runtime because:
 *
 *   1. The web app doesn't import `@ever-works/job-runtime-*-plugin`
 *      packages — that would pull bullmq/pg-boss/@temporalio/inngest
 *      transitive deps into the browser bundle for no runtime gain.
 *   2. The plugin manifests already act as the contract source —
 *      these definitions sit alongside them as the UI projection
 *      and the operator-wiring docs (providers.md) document the
 *      credential bag shape verbatim.
 *
 * EW-743 (PR #1548) — Trigger.dev gained per-tenant BYO credentials
 * gated by the existing tenant overlay `mode` discriminator
 * (`inherit` | `byo` | `override`). Required-when-mode-in-[byo,
 * override] is expressed via the `requiredWhen` predicate on each
 * field; `inherit` falls back to the operator-default project.
 *
 * Each field declares:
 *   - `name`: the key in the credentials JSON object posted to the
 *     server (matches the plugin's settingsSchema.properties.<name>)
 *   - `label`: human-readable label
 *   - `description`: helper text shown under the field
 *   - `secret`: render as masked password input (true) or plain text (false)
 *   - `required`: client-side validation on save (always-required;
 *     mode-conditional requiredness uses `requiredWhen` instead)
 *   - `requiredWhen`: discriminator-driven requiredness — currently
 *     only `mode` is supported (set of mode values that make the
 *     field required). Fields without `required` and without a
 *     matching `requiredWhen` entry are optional. Trigger.dev's
 *     `accessToken` / `secretKey` / `projectRef` use
 *     `requiredWhen: { mode: ['byo', 'override'] }` to mirror the
 *     plugin's JSON-Schema `if/then` rule.
 *   - `envVar`: documentation hint shown next to the field for
 *     operators who prefer the env-var fallback
 *   - `placeholder`: input placeholder
 *   - `multiline`: render as <textarea> (true) — used for PEM-encoded
 *     mTLS cert/key pairs
 */
import type {
    TenantJobRuntimeMode,
    TenantJobRuntimeProviderId,
} from '@/lib/api/tenant-job-runtime';

export interface JobRuntimeCredentialField {
    readonly name: string;
    readonly label: string;
    readonly description: string;
    readonly secret: boolean;
    readonly required: boolean;
    readonly requiredWhen?: { readonly mode: readonly TenantJobRuntimeMode[] };
    readonly envVar?: string;
    readonly placeholder?: string;
    readonly multiline?: boolean;
}

export const JOB_RUNTIME_CREDENTIAL_SCHEMAS: Record<
    TenantJobRuntimeProviderId,
    readonly JobRuntimeCredentialField[]
> = {
    trigger: [
        {
            name: 'accessToken',
            label: 'Personal Access Token (PAT)',
            description:
                'Trigger.dev management PAT (tr_pat_…) from your Trigger.dev account. Required for BYO / Override; unused in Inherit mode.',
            secret: true,
            required: false,
            requiredWhen: { mode: ['byo', 'override'] },
            envVar: 'TRIGGER_ACCESS_TOKEN',
            placeholder: 'tr_pat_…',
        },
        {
            name: 'secretKey',
            label: 'Project Secret Key',
            description:
                'Project-scoped server secret (tr_dev_… or tr_prod_…) used by the SDK to authenticate tasks.trigger calls. Required for BYO / Override.',
            secret: true,
            required: false,
            requiredWhen: { mode: ['byo', 'override'] },
            envVar: 'TRIGGER_SECRET_KEY',
            placeholder: 'tr_prod_…',
        },
        {
            name: 'projectRef',
            label: 'Project Ref',
            description:
                'Trigger.dev project reference (e.g. proj_abc123). Required for BYO / Override.',
            secret: false,
            required: false,
            requiredWhen: { mode: ['byo', 'override'] },
            envVar: 'TRIGGER_PROJECT_REF',
            placeholder: 'proj_…',
        },
        {
            name: 'apiUrl',
            label: 'API URL (self-hosted only)',
            description:
                'Override the Trigger.dev API endpoint for a self-hosted instance. Leave blank to use https://api.trigger.dev.',
            secret: false,
            required: false,
            envVar: 'TRIGGER_API_URL',
            placeholder: 'https://api.trigger.dev',
        },
    ],
    bullmq: [
        {
            name: 'redisUrl',
            label: 'Redis URL',
            description: 'BullMQ Redis connection string. Required for byo/override modes.',
            secret: true,
            required: true,
            envVar: 'BULLMQ_REDIS_URL',
            placeholder: 'redis://default:password@host:6379',
        },
        {
            name: 'queuePrefix',
            label: 'Queue prefix',
            description:
                'Per-tenant Redis key prefix for queue isolation. Falls back to a tenant-derived default when blank.',
            secret: false,
            required: false,
            envVar: 'BULLMQ_QUEUE_PREFIX',
            placeholder: 'tenant-acme',
        },
    ],
    pgboss: [
        {
            name: 'connectionString',
            label: 'Postgres connection string',
            description: 'pg-boss connection string. Required for byo/override modes.',
            secret: true,
            required: true,
            envVar: 'PGBOSS_CONNECTION_STRING',
            placeholder: 'postgres://user:password@host:5432/db',
        },
        {
            name: 'schema',
            label: 'pg-boss schema',
            description:
                'Per-tenant Postgres schema for queue isolation (ADR-017 Q2). Falls back to instance default when blank.',
            secret: false,
            required: false,
            envVar: 'PGBOSS_SCHEMA',
            placeholder: 'tenant_acme',
        },
    ],
    temporal: [
        {
            name: 'namespace',
            label: 'Temporal namespace',
            description: 'Per-tenant Temporal namespace (ADR-017 Q1 namespace-per-tenant).',
            secret: false,
            required: true,
            envVar: 'TEMPORAL_NAMESPACE',
            placeholder: 'tenant-acme',
        },
        {
            name: 'address',
            label: 'Temporal address',
            description: "gRPC endpoint for the tenant's Temporal cluster.",
            secret: false,
            required: false,
            envVar: 'TEMPORAL_ADDRESS',
            placeholder: 'temporal.tenant-acme.svc:7233',
        },
        {
            name: 'tlsCert',
            label: 'TLS client certificate (PEM)',
            description:
                'mTLS client cert for connecting to a tenant cluster. Paste the full PEM block.',
            secret: true,
            required: false,
            envVar: 'TEMPORAL_TLS_CERT',
            multiline: true,
            placeholder: '-----BEGIN CERTIFICATE-----\n...',
        },
        {
            name: 'tlsKey',
            label: 'TLS client key (PEM)',
            description: 'mTLS client key paired with the cert above.',
            secret: true,
            required: false,
            envVar: 'TEMPORAL_TLS_KEY',
            multiline: true,
            placeholder: '-----BEGIN PRIVATE KEY-----\n...',
        },
    ],
    inngest: [
        {
            name: 'eventKey',
            label: 'Inngest event key',
            description:
                "Used by `inngest.send()` to publish events to the tenant's Inngest project. SaaS only.",
            secret: true,
            required: true,
            envVar: 'INNGEST_EVENT_KEY',
        },
        {
            name: 'signingKey',
            label: 'Inngest signing key',
            description: 'Used to verify inbound webhook requests from Inngest. SaaS only.',
            secret: true,
            required: true,
            envVar: 'INNGEST_SIGNING_KEY',
        },
    ],
};

/**
 * Providers that never expose tenant-overlay credentials through the
 * tenant form. As of EW-743 (PR #1548), Trigger.dev is no longer in
 * this set — tenants can supply per-project credentials in `byo` /
 * `override` mode. Reserved for future provider plugins that remain
 * operator-only.
 */
export const PROVIDERS_WITHOUT_CREDENTIALS: ReadonlySet<TenantJobRuntimeProviderId> =
    new Set<TenantJobRuntimeProviderId>();

/**
 * EW-743 — per-provider, per-mode helper banner shown above the
 * credentials block. Currently only Trigger.dev varies copy by mode
 * (inherit suppresses the credential trio entirely; byo and override
 * use the same credential shape but communicate different operator
 * intent). Other providers can opt in by adding an entry here.
 */
export const JOB_RUNTIME_PROVIDER_MODE_BANNERS: Partial<
    Record<TenantJobRuntimeProviderId, Readonly<Record<TenantJobRuntimeMode, string>>>
> = {
    trigger: {
        inherit:
            "Using the platform's shared Trigger.dev project. No tenant credentials are required — jobs dispatch through the operator-default project.",
        byo: 'Bring your own Trigger.dev account + project. Paste the PAT, project secret key, and project ref from your Trigger.dev dashboard.',
        override:
            "Override the platform default with your own Trigger.dev project. Same credential shape as BYO — choose this when you're explicitly opting out of the platform default rather than supplementing it.",
    },
};

/**
 * Resolve the effective `required` flag for a field given the current
 * tenant overlay mode. Honors `requiredWhen.mode` (mode-discriminated
 * requiredness — see PR #1548 `if/then` rule on Trigger.dev) and
 * falls back to the field's static `required` flag.
 */
export function isFieldRequired(
    field: JobRuntimeCredentialField,
    mode: TenantJobRuntimeMode,
): boolean {
    if (field.requiredWhen?.mode) {
        return field.requiredWhen.mode.includes(mode);
    }
    return field.required;
}

/**
 * Resolve whether a field should be visible at all for the given mode.
 * Today a field is hidden only when it has a `requiredWhen.mode`
 * predicate AND the current mode is NOT in the predicate set (i.e. the
 * field is purely a mode-conditional credential — e.g. Trigger.dev's
 * accessToken in inherit mode). Always-optional fields like
 * Trigger.dev's `apiUrl` remain visible regardless of mode so operators
 * can opt into self-host overrides.
 *
 * Note: callers may additionally suppress the entire credentials block
 * (e.g. on `inherit` mode), so this only matters when the block is
 * being rendered.
 */
export function isFieldVisibleForMode(
    field: JobRuntimeCredentialField,
    mode: TenantJobRuntimeMode,
): boolean {
    if (field.requiredWhen?.mode) {
        return field.requiredWhen.mode.includes(mode);
    }
    return true;
}
