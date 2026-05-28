import 'server-only';
import { PostHog } from 'posthog-node';

/**
 * Server-side gating for the dashboard "work kind" chips.
 *
 * The web app deliberately keeps `posthog-js` OUT of the client bundle
 * (see `apps/web/src/app/actions/onboarding/track.ts`) so PostHog tokens
 * never reach the browser. Feature flags are therefore evaluated here,
 * server-side, with `posthog-node`, and only the resulting "disabled"
 * set is serialized down to the client chip components.
 *
 * Semantics — DEFAULT IS ENABLED (fail-open):
 *   - No `POSTHOG_API_KEY`, unreachable PostHog, an error, a missing flag,
 *     or an `undefined` value → the chip is ENABLED (NOT coming soon).
 *   - A chip is only added to the "disabled" set when its flag resolves
 *     strictly to `false`.
 *
 * This guarantees OSS forks with no PostHog config get every kind enabled.
 */

/** Flag key convention: chip value `blog` → flag `works-blog`. */
export const workKindFlagKey = (value: string) => `works-${value}`;

/**
 * Hard cap so a slow/hung PostHog can never block page rendering.
 * On timeout we fail open (treat everything as enabled).
 */
const FLAG_EVAL_TIMEOUT_MS = 1500;

// Module-level singleton — never construct a client per request.
// `null` once we've determined there's no key (so we don't re-check
// the env on every call). `undefined` means "not yet initialised".
let cachedClient: PostHog | null | undefined;

function getClient(): PostHog | null {
    if (cachedClient !== undefined) {
        return cachedClient;
    }

    const apiKey = process.env.POSTHOG_API_KEY;
    if (!apiKey) {
        cachedClient = null;
        return cachedClient;
    }

    const host = process.env.POSTHOG_HOST || 'https://app.posthog.com';
    cachedClient = new PostHog(apiKey, { host });
    return cachedClient;
}

/**
 * Returns the set of work-kind values whose feature flag is explicitly
 * `false`. Fails open on every other outcome (no key, error, timeout,
 * missing/undefined flag). NEVER throws.
 */
export async function getDisabledWorkKinds(
    values: readonly string[],
    distinctId?: string,
): Promise<Set<string>> {
    const disabled = new Set<string>();

    try {
        const client = getClient();
        if (!client) {
            return disabled;
        }

        const id = distinctId ?? 'anonymous';
        const evaluate = Promise.all(
            values.map(async (value) => {
                const enabled = await client.isFeatureEnabled(workKindFlagKey(value), id, {
                    sendFeatureFlagEvents: false,
                });
                // Only an explicit `false` disables the chip. `true` and
                // `undefined` (missing flag) both mean enabled.
                if (enabled === false) {
                    disabled.add(value);
                }
            }),
        ).then(() => undefined);

        const timeout = new Promise<undefined>((resolve) => {
            setTimeout(resolve, FLAG_EVAL_TIMEOUT_MS);
        });

        // Whichever wins, we return whatever we managed to compute so far.
        // On timeout `disabled` simply holds the flags resolved in time.
        await Promise.race([evaluate, timeout]);
    } catch {
        // Fail open: never let telemetry/flag plumbing break the page.
        return disabled;
    }

    return disabled;
}
