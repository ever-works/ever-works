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
 *
 * Semantics — ONE EXCEPTION, fail-CLOSED ({@link FAIL_CLOSED_WORK_KINDS}):
 *   - The kinds in that list (today just `app`, APW-01 / Resolution R-6) are
 *     DISABLED unless their flag resolves strictly to `true` **and** the
 *     API-side gate has not turned them off. "We could not tell" — no key,
 *     missing flag, `undefined`, an error, a timeout that returned a partial
 *     set — means the chip is ABSENT, because the App surface is unfinished
 *     and a flag service being slow must not leak it into the picker.
 *   - Their disabled state is PRE-SEEDED, so a timeout cannot hand back a set
 *     that re-enables them.
 *
 * Every other kind keeps the fail-open behaviour above, unchanged.
 */

/** Flag key convention: chip value `blog` → flag `works-blog`. */
export const workKindFlagKey = (value: string) => `works-${value}`;

/**
 * Kinds whose chip fails CLOSED (APW-01 T7b, Resolution R-6).
 *
 * Membership is the ONE thing that decides the semantics above, so the list is
 * exported and deliberately tiny: a kind joins it only while its surface is
 * unfinished and leaking it would be worse than hiding it.
 *
 * APW-01 T20 moves this list behind `apps/web/src/lib/work-kinds/flag-gated-kinds.ts`
 * (`HIDDEN_WHEN_DISABLED_WORK_KINDS`) and lets the runtime instance setting
 * (`EVER_WORKS_APP_WORKS_ENABLED`, the API twin) decide the no-PostHog case;
 * the fail-closed behaviour here is what it builds on.
 */
export const FAIL_CLOSED_WORK_KINDS = ['app'] as const;

const FAIL_CLOSED: ReadonlySet<string> = new Set<string>(FAIL_CLOSED_WORK_KINDS);

/**
 * The API-side half of the gate, when the caller can read it.
 *
 * APW-01 T7b makes the chip require BOTH halves for a fail-closed kind: the
 * PostHog flag must resolve strictly to `true`, and the API-side App Works
 * switch must not contradict it. `appWorksEnabled: false` therefore always
 * hides the kind — a chip for a surface the API refuses would be a dead end —
 * while an omitted value leaves the decision to the flag alone (the caller has
 * not wired the switch yet; APW-01 T20 wires it).
 */
export interface WorkKindFlagGate {
    /** `EVER_WORKS_APP_WORKS_ENABLED` as the server resolved it for this request. */
    readonly appWorksEnabled?: boolean;
}

/**
 * Hard cap so a slow/hung PostHog can never block page rendering.
 * On timeout we fail open (treat everything as enabled) — except the
 * fail-CLOSED kinds, which the pre-seeded set already holds disabled.
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
 * `false` — plus, for the fail-CLOSED kinds, every value whose flag did not
 * resolve strictly to `true`. Fails open on every other outcome (no key,
 * error, timeout, missing/undefined flag). NEVER throws.
 */
export async function getDisabledWorkKinds(
    values: readonly string[],
    distinctId?: string,
    gate?: WorkKindFlagGate,
): Promise<Set<string>> {
    // Fail-CLOSED kinds start disabled: every path below (no client, error,
    // timeout, partial set) must leave them out of the picker, so the choice
    // is made here — before any evaluation — and only an explicit `true`
    // clears it.
    const disabled = new Set<string>(values.filter((value) => FAIL_CLOSED.has(value)));

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
                if (FAIL_CLOSED.has(value)) {
                    // Fail CLOSED: only a strict `true`, with the API-side
                    // gate not contradicting it, re-enables the chip.
                    if (enabled === true && gate?.appWorksEnabled !== false) {
                        disabled.delete(value);
                    } else {
                        disabled.add(value);
                    }
                    return;
                }
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
        // Fail open for every ordinary kind: never let telemetry/flag
        // plumbing break the page. The fail-CLOSED kinds are still in
        // `disabled`, so this stays fail-closed for them.
        return disabled;
    }

    return disabled;
}
