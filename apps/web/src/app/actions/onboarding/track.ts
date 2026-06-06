'use server';

import { onboardingAPI } from '@/lib/api/onboarding';

/**
 * Best-effort telemetry relay for the v2 onboarding wizard.
 *
 * The browser POSTs `{ event, properties }` to this server action, which
 * forwards to `/api/onboarding/telemetry`. The API validates the event
 * against an allowlist and forwards to PostHog via the existing
 * `AnalyticsService`.
 *
 * Older path: this server-side relay predates the client-side `posthog-js`
 * integration. Newer client surfaces should call PostHog directly via
 * `usePostHog()` from `posthog-js/react` (the provider is wired in
 * `apps/web/src/app/[locale]/layout.tsx`). This server action stays for the
 * onboarding-wizard event taxonomy that the API consolidates server-side
 * (allowlist validation + canonical property shaping live in the API).
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
        // Security: strip newlines/CRs from the event name to prevent log injection
        const safeEvent = event.replace(/[\r\n]/g, '_');
        // eslint-disable-next-line no-console -- intentional: telemetry is best-effort
        console.warn(`trackOnboardingEvent(${safeEvent}) failed: ${(cause as Error).message}`);
    }
}
