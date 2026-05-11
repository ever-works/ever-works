'use server';

import { onboardingAPI } from '@/lib/api/onboarding';

/**
 * Best-effort telemetry relay for the v2 onboarding wizard.
 *
 * The browser POSTs `{ event, properties }` to this server action, which
 * forwards to `/api/onboarding/telemetry`. The API validates the event
 * against an allowlist and forwards to PostHog via the existing
 * `AnalyticsService`. We deliberately do NOT add `posthog-js` to the
 * web bundle — keeping the relay server-side means PostHog tokens stay
 * out of the client and we don't pay the bundle cost.
 *
 * Failures are swallowed: telemetry must never block the wizard.
 */
export async function trackOnboardingEvent(
    event: string,
    properties?: Record<string, unknown>,
): Promise<void> {
    try {
        await onboardingAPI.track(event, properties);
    } catch (cause) {
        // eslint-disable-next-line no-console -- intentional: telemetry is best-effort
        console.warn(
            `trackOnboardingEvent(${event}) failed: ${(cause as Error).message}`,
        );
    }
}
