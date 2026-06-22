import { randomBytes } from 'node:crypto';

/**
 * API-side helpers used by `global-setup.ts` to seed two tenants
 * against a live local API:
 *
 *   - Tenant A (`primary`)   — has a job-runtime config row with a
 *                              resolvable `credentialsSecretRef` carrying
 *                              `{webhookSecret}` (used by 11 of the 12
 *                              webhook spec cases).
 *   - Tenant B (`secondary`) — has NO job-runtime config (used by the
 *                              "tenant exists but webhookSecret bag
 *                              absent" case to land the spec at 12/12).
 *
 * The seed chain is:
 *   POST /api/auth/register        → access_token
 *   POST /api/organizations        → tenantId
 *   PUT  /api/account/job-runtime/config  (only for tenant A)
 *
 * The PUT payload uses the documented `inline:<base64>` secret-ref
 * scheme that the in-process secret-store resolver decodes — keeps the
 * ref ≤128 chars (the column cap).
 */

export interface SeededUser {
    username: string;
    email: string;
    password: string;
    accessToken: string;
}

export interface SeededTenant {
    user: SeededUser;
    tenantId: string;
    slug: string;
}

const PASSWORD = 'E2eSeed1234!secure';

function uniqueSuffix(): string {
    // Worker pid + 4 random bytes — collision-free across parallel
    // setup runs and across multiple invocations on the same machine.
    return `${process.pid}-${randomBytes(4).toString('hex')}`;
}

export async function registerSeedUser(
    apiBase: string,
    label: 'primary' | 'secondary',
): Promise<SeededUser> {
    const suffix = uniqueSuffix();
    const username = `e2e-seed-${label}-${suffix}`;
    const email = `e2e-seed-${label}-${suffix}@test.local`;
    const res = await fetch(`${apiBase}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, email, password: PASSWORD }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(
            `[api-seed] register(${label}) failed ${res.status}: ${body}`,
        );
    }
    const json = (await res.json()) as { access_token: string };
    return { username, email, password: PASSWORD, accessToken: json.access_token };
}

export async function createOrganization(
    apiBase: string,
    user: SeededUser,
    label: 'primary' | 'secondary',
): Promise<SeededTenant> {
    const suffix = uniqueSuffix();
    const slug = `e2e-org-${label}-${suffix}`;
    const name = `E2E Org ${label} ${suffix}`;
    const res = await fetch(`${apiBase}/api/organizations`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${user.accessToken}`,
        },
        body: JSON.stringify({ name, slug }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(
            `[api-seed] createOrg(${label}) failed ${res.status}: ${body}`,
        );
    }
    const json = (await res.json()) as { tenantId: string };
    if (!json.tenantId) {
        throw new Error(
            `[api-seed] createOrg(${label}) response missing tenantId: ${JSON.stringify(json)}`,
        );
    }
    return { user, tenantId: json.tenantId, slug };
}

export async function putTriggerWebhookConfig(
    apiBase: string,
    tenant: SeededTenant,
    webhookSecret: string,
): Promise<void> {
    const bag = { webhookSecret };
    const base64 = Buffer.from(JSON.stringify(bag), 'utf8').toString('base64');
    const credentialsSecretRef = `inline:${base64}`;
    if (credentialsSecretRef.length > 128) {
        throw new Error(
            `[api-seed] credentialsSecretRef too long (${credentialsSecretRef.length} > 128). Shorten the bag.`,
        );
    }
    const res = await fetch(`${apiBase}/api/account/job-runtime/config`, {
        method: 'PUT',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tenant.user.accessToken}`,
        },
        body: JSON.stringify({
            providerId: 'trigger',
            mode: 'byo',
            credentialsSecretRef,
            enabled: true,
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(
            `[api-seed] putConfig failed ${res.status}: ${body}`,
        );
    }
}

export function newWebhookSecret(): string {
    return `whsec_e2e_${randomBytes(16).toString('hex')}`;
}

/**
 * PUT a job-runtime config for a tenant with a credentials bag that
 * deliberately does NOT carry a `webhookSecret` field. Used by the
 * webhook receiver spec's "tenant exists but webhookSecret bag absent
 * → 401" case (#1533/#1537/#1542 contract: the receiver must fail
 * closed at signature when the bag is present but the field is
 * missing, not 404).
 *
 * Without this seeded row the secondary tenant has NO config at all,
 * so the controller treats the tenant as having no provider configured
 * and returns 404 (different semantic path), which the spec correctly
 * reports as a mismatch.
 *
 * The bag is `{}` — present but missing the field — so the secret-ref
 * resolver returns an object that lacks `webhookSecret`, exactly the
 * shape the fail-closed branch is meant to cover.
 */
export async function putTriggerEmptyBagConfig(
    apiBase: string,
    tenant: SeededTenant,
): Promise<void> {
    const bag = {};
    const base64 = Buffer.from(JSON.stringify(bag), 'utf8').toString('base64');
    const credentialsSecretRef = `inline:${base64}`;
    const res = await fetch(`${apiBase}/api/account/job-runtime/config`, {
        method: 'PUT',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${tenant.user.accessToken}`,
        },
        body: JSON.stringify({
            providerId: 'trigger',
            mode: 'byo',
            credentialsSecretRef,
            enabled: true,
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(
            `[api-seed] putEmptyBagConfig failed ${res.status}: ${body}`,
        );
    }
}
