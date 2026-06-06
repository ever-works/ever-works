/**
 * Env-driven detection of which third-party integrations the platform is
 * configured to use. This mirrors the same env checks the rest of the API
 * already uses (e.g. `SENTRY_DSN`, `POSTHOG_API_KEY`, `TRIGGER_ENABLED`),
 * centralised here so the health endpoint can report them in one place.
 *
 * IMPORTANT: this only reports *whether a service is configured* + a coarse
 * mode label. It never reads or echoes the secret values themselves.
 */

export interface ServiceStatus {
    /** Stable key used as the health-indicator name (snake_case). */
    key: string;
    /** Whether the env signals this integration is wired up. */
    configured: boolean;
    /** Coarse, non-secret descriptor (provider name / backend / `disabled`). */
    mode: string;
}

const has = (...vals: Array<string | undefined>): boolean => vals.some((v) => !!(v && v.trim()));

/**
 * Redis connection string if the platform is configured to use Redis
 * (shared by the distributed throttler and agent queues), else `null`.
 */
export function getRedisUrl(): string | null {
    return process.env.REDIS_URL?.trim() || process.env.THROTTLER_REDIS_URL?.trim() || null;
}

/**
 * Informational integrations reported by the readiness endpoint. These never
 * fail the aggregate health (they're reported, not pinged) — the goal is
 * visibility into what's wired up, not a hard readiness gate.
 */
export function detectInformationalServices(): ServiceStatus[] {
    const aiConfigured = has(
        process.env.PLUGIN_OPENROUTER_API_KEY,
        process.env.OPENAI_API_KEY,
        process.env.ANTHROPIC_API_KEY,
    );
    const triggerConfigured =
        process.env.TRIGGER_ENABLED === 'true' && has(process.env.TRIGGER_SECRET_KEY);
    const stripeConfigured =
        has(process.env.STRIPE_SECRET_KEY) && process.env.SUBSCRIPTIONS_ENABLED === 'true';
    const mailer = process.env.MAILER_PROVIDER?.trim();
    const emailConfigured = !!mailer && !['faker', 'none'].includes(mailer);

    // Security: Strip provider/backend names from public-facing mode labels so that
    // the unauthenticated /api/health/ready response does not reveal the third-party
    // integration topology (which AI gateway, email provider, storage backend, etc.).
    // All entries now emit only 'enabled' | 'disabled' — boolean visibility without
    // naming the vendor.
    const storageConfigured = has(process.env.STORAGE_BACKEND);

    return [
        {
            key: 'ai_provider',
            configured: aiConfigured,
            mode: aiConfigured ? 'enabled' : 'disabled',
        },
        {
            key: 'sentry',
            configured: has(process.env.SENTRY_DSN),
            mode: has(process.env.SENTRY_DSN) ? 'enabled' : 'disabled',
        },
        {
            key: 'posthog',
            configured: has(process.env.POSTHOG_API_KEY),
            mode: has(process.env.POSTHOG_API_KEY) ? 'enabled' : 'disabled',
        },
        {
            key: 'trigger_dev',
            configured: triggerConfigured,
            mode: triggerConfigured ? 'enabled' : 'disabled',
        },
        {
            key: 'stripe',
            configured: stripeConfigured,
            mode: stripeConfigured ? 'enabled' : 'disabled',
        },
        {
            key: 'email',
            configured: emailConfigured,
            mode: emailConfigured ? 'enabled' : 'disabled',
        },
        {
            key: 'storage',
            configured: storageConfigured,
            mode: storageConfigured ? 'enabled' : 'disabled',
        },
    ];
}
