/**
 * Env-driven detection of which third-party integrations the platform is
 * configured to use. This mirrors the same env checks the rest of the API
 * already uses (e.g. `SENTRY_DSN`, `POSTHOG_API_KEY`, `TRIGGER_ENABLED`),
 * centralised here so the health endpoint can report them in one place.
 *
 * IMPORTANT: this only reports *whether a service is configured* + a coarse
 * mode label. It never reads or echoes the secret values themselves.
 */

import { inspectTemplatesDir } from '../mail/templates';

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
            // Vendor-neutral view of "can background agent runs execute at
            // all?" — the signal the dashboard's degradation banner keys on.
            // Today the dispatch path executes exclusively on the trigger
            // runtime, so this mirrors trigger_dev; when the job-runtime
            // provider registry is wired end-to-end (EW-686), this entry
            // reflects WHICHEVER runtime `EVER_WORKS_JOB_RUNTIME` selects,
            // while trigger_dev stays vendor-specific. Kept as a separate
            // key so clients written against `job_runtime` never re-key.
            key: 'job_runtime',
            configured: triggerConfigured,
            mode: triggerConfigured ? 'enabled' : 'disabled',
        },
        {
            key: 'stripe',
            configured: stripeConfigured,
            mode: stripeConfigured ? 'enabled' : 'disabled',
        },
        {
            // `configured` reflects the env only; `mode` additionally reports
            // whether the Handlebars templates were actually shipped in this
            // image. Before this check, production reported
            // `email: { configured: true, mode: 'enabled' }` while EVERY
            // templated email threw ENOENT — the status surface asserted a
            // working mailer that could not send a single message. `degraded`
            // is a non-secret label (no vendor name), consistent with the
            // stripping note above.
            key: 'email',
            configured: emailConfigured,
            mode: !emailConfigured ? 'disabled' : inspectTemplatesDir().ok ? 'enabled' : 'degraded',
        },
        {
            key: 'storage',
            configured: storageConfigured,
            mode: storageConfigured ? 'enabled' : 'disabled',
        },
    ];
}
