/**
 * Allow-list for the operator-managed, per-Work **application runtime env**
 * that a deployed directory site reads at runtime — today the Stripe payment
 * configuration the `directory-web-template` consumes via `process.env`.
 *
 * These keys are the ONLY ones `WorkRuntimeEnvService.setRuntimeEnvVars`
 * accepts; anything else is rejected with a 400. The platform-managed keys
 * (`AUTH_SECRET`, `COOKIE_SECRET`, `DATABASE_URL`, `GH_TOKEN`,
 * `DATA_REPOSITORY`, `TENANT_ID`, `SITE_URL`, `PLATFORM_*`, …) are minted by
 * their own code paths in `DeployService` / `WorkRuntimeEnvService` and are
 * deliberately NOT listed here so a dashboard user can never override them.
 *
 * Values are persisted AES-256-GCM-encrypted on `works.deployRuntimeEnvEncrypted`
 * (a single JSON map) and delivered on every deploy:
 *  - server-side managed k8s deploys: merged into the `${slug}-runtime-env`
 *    Secret the platform applies (`DeployService.collectServerSideRuntimeEnv`);
 *  - workflow deploys: pushed as GitHub Actions repo secrets so
 *    `deploy_k8s.yaml` / the Vercel workflows can forward them.
 *
 * Keep this list small and intentional — every entry is something the
 * deployed site actually reads. See `docs/runbooks/WORK_RUNTIME_ENV.md`.
 */
export const WORK_RUNTIME_ENV_ALLOWED_KEYS = [
    'NEXT_PUBLIC_PAYMENT_PROVIDER',
    'STRIPE_SECRET_KEY',
    'STRIPE_PUBLISHABLE_KEY',
    'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'NEXT_PUBLIC_STRIPE_DYNAMIC_PRICING',
    'STRIPE_SPONSOR_WEEKLY_PRICE_ID',
    'STRIPE_SPONSOR_MONTHLY_PRICE_ID',
] as const;

export type WorkRuntimeEnvKey = (typeof WORK_RUNTIME_ENV_ALLOWED_KEYS)[number];

/**
 * Subset of the allow-list whose values are credentials. They are never
 * echoed back by the API — `describeRuntimeEnvVars` masks them to `***`
 * (non-secret keys are shown as a short prefix so an operator can tell
 * which key is configured without leaking it).
 */
export const WORK_RUNTIME_ENV_SECRET_KEYS: ReadonlySet<WorkRuntimeEnvKey> =
    new Set<WorkRuntimeEnvKey>(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);

/** Upper bound on a single stored value (trimmed). */
export const WORK_RUNTIME_ENV_MAX_VALUE_LENGTH = 4096;

/** Visible prefix length for a non-secret value in the masked API view. */
export const WORK_RUNTIME_ENV_MASK_PREFIX_LENGTH = 7;

/** What the API returns per allow-listed key (values are never plaintext). */
export interface WorkRuntimeEnvVarState {
    key: WorkRuntimeEnvKey;
    /** Whether a value is currently stored for this key. */
    set: boolean;
    /** Masked preview (`***` for secrets, short prefix otherwise); null when unset. */
    masked: string | null;
    /** True for credential keys that are always fully masked. */
    secret: boolean;
}

export function isWorkRuntimeEnvKey(key: string): key is WorkRuntimeEnvKey {
    return (WORK_RUNTIME_ENV_ALLOWED_KEYS as readonly string[]).includes(key);
}

export function isWorkRuntimeEnvSecretKey(key: string): boolean {
    return isWorkRuntimeEnvKey(key) && WORK_RUNTIME_ENV_SECRET_KEYS.has(key);
}

/**
 * Mask a stored value for display. Secrets collapse to `***`; non-secret
 * values keep a short prefix (`pk_live…`, `price_1…`) so an operator can
 * recognise what is configured. Short non-secret values (`stripe`, `true`)
 * are returned verbatim — there is nothing to hide in a feature toggle.
 */
export function maskWorkRuntimeEnvValue(key: string, value: string): string {
    if (isWorkRuntimeEnvSecretKey(key)) {
        return '***';
    }
    if (value.length <= WORK_RUNTIME_ENV_MASK_PREFIX_LENGTH) {
        return value;
    }
    return `${value.slice(0, WORK_RUNTIME_ENV_MASK_PREFIX_LENGTH)}…`;
}
