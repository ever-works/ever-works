import 'server-only';
import type { EverIdAvailability } from '@ever-works/contracts';
import { getPostHogClient } from './posthog-client';

/**
 * APW-12 (Ever ID) — the `ever-id` rollout flag (spec FR-1, ACC-12-01/02;
 * plan §6.4).
 *
 * ## Fail CLOSED, with one deliberate exception
 *
 * Sign in with Ever ID is offered only when an administrator has enabled the
 * integration **and** the `ever-id` flag is on for the viewer. A flag that cannot
 * be evaluated is **off**: an error, a timeout past the budget, a missing flag
 * (`undefined`) and any truthy value that is not strictly `true` all hide the
 * button. A sign-in method that appeared because a flag service was slow would be
 * a method nobody rolled out.
 *
 * The exception is an installation with **no rollout-flag service at all**
 * (`POSTHOG_API_KEY` unset): there the configuration alone decides, so the helper
 * answers `true` and the administrator's switch is the only gate. An
 * authentication method must not be switched off by an absent analytics key.
 *
 * ## Deliberately not the Work-kind policy
 *
 * `./work-kinds.ts` reads a missing key the other way for its fail-closed kinds.
 * The two helpers share the PostHog client (`./posthog-client`) and nothing else,
 * and `ever-id.flag.unit.spec.ts` pins both behaviours so a later unification
 * cannot silently change either.
 *
 * ## Zero outbound calls while Ever ID is off
 *
 * Callers go through {@link isEverIdOffered}, which never asks PostHog unless the
 * API reported `everId.enabled: true` — so an installation that has not turned
 * Ever ID on makes no flag request at all.
 */

/** The flag key, named once. */
export const EVER_ID_FLAG_KEY = 'ever-id';

/**
 * The distinct id the signed-out pages (sign-in, registration) evaluate the flag
 * with, so a staff-only rollout reaches Settings → Connect first and the sign-in
 * button only once the flag is on for everyone (plan §6.4).
 */
export const EVER_ID_ANONYMOUS_DISTINCT_ID = 'anonymous';

/** Hard cap so a slow flag service can never hold up a page render. */
export const EVER_ID_FLAG_BUDGET_MS = 1500;

/**
 * Whether the `ever-id` flag is on for `distinctId`. NEVER throws.
 *
 * `true` when PostHog is not configured (configuration decides); otherwise `true`
 * only for a strict `true` answered within {@link EVER_ID_FLAG_BUDGET_MS}.
 */
export async function isEverIdFlagOn(distinctId: string): Promise<boolean> {
    let client: ReturnType<typeof getPostHogClient>;
    try {
        client = getPostHogClient();
    } catch {
        // A key is configured but the client could not be built: the flag
        // service exists and cannot answer, which is "off".
        return false;
    }

    if (!client) {
        return true;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const evaluation = client
            .isFeatureEnabled(EVER_ID_FLAG_KEY, distinctId, { sendFeatureFlagEvents: false })
            .then((value) => value === true);

        const timeout = new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), EVER_ID_FLAG_BUDGET_MS);
        });

        return await Promise.race([evaluation, timeout]);
    } catch {
        return false;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/**
 * Whether to offer Ever ID to this viewer: the administrator's switch first, and
 * the rollout flag only when that switch is on (so nothing is asked of PostHog
 * while Ever ID is off).
 */
export async function isEverIdOffered(
    availability: Pick<EverIdAvailability, 'enabled'>,
    distinctId: string,
): Promise<boolean> {
    if (availability.enabled !== true) {
        return false;
    }

    return isEverIdFlagOn(distinctId);
}
