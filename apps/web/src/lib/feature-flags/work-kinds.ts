import 'server-only';
import { PostHog } from 'posthog-node';
import { HIDDEN_WHEN_DISABLED_WORK_KINDS } from '@/lib/work-kinds/flag-gated-kinds';

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
 * The list itself now lives in `@/lib/work-kinds/flag-gated-kinds` (T20), which
 * is importable from client components too, so the fail-closed flag set and the
 * chip removal cannot drift apart. This name is kept — it reads better at the
 * call site — and simply re-points at that ONE list.
 */
export const FAIL_CLOSED_WORK_KINDS = HIDDEN_WHEN_DISABLED_WORK_KINDS;

const FAIL_CLOSED: ReadonlySet<string> = new Set<string>(FAIL_CLOSED_WORK_KINDS);

/**
 * The API-side half of the gate, when the caller can read it.
 *
 * APW-01 T7b makes the chip require BOTH halves for a fail-closed kind: the
 * PostHog flag must resolve strictly to `true`, and the API-side App Works
 * switch must not contradict it. `appWorksEnabled: false` therefore always
 * hides the kind — a chip for a surface the API refuses would be a dead end.
 *
 * **T20 gave the omitted case a source of its own** (see
 * {@link readAppWorksInstanceSetting}): an install with no PostHog at all used
 * to decide on nothing, so `app` was invisible even where it was switched on.
 */
export interface WorkKindFlagGate {
    /** `EVER_WORKS_APP_WORKS_ENABLED` as the server resolved it for this request. */
    readonly appWorksEnabled?: boolean;
}

/**
 * The runtime instance setting, read at CALL time (APW-01 T20).
 *
 * Two things this deliberately is not:
 *
 *  - **Not a build-time `NEXT_PUBLIC_*` variable.** A value baked into the bundle
 *    cannot differ per instance, and the whole point of this switch is that a
 *    self-hosted install, the PR e2e lane and local development each decide for
 *    themselves.
 *  - **Not read at module load.** `getDisabledWorkKinds` is called per request,
 *    so reading the environment there means a container restarted with a
 *    different value behaves correctly without a rebuild.
 *
 * Exactly `'true'` is on, the same posture as the API's own
 * `config.appLauncher.isEnabled()` and T31's deploy-manifest spec: a stray `1`
 * in an environment file is a mistake far more often than an intentional switch,
 * and this gate hides a surface rather than merely dimming it. When the API
 * starts publishing its twin on `/api/config`, the caller passes
 * `gate.appWorksEnabled` and that value wins over this fallback.
 */
function readAppWorksInstanceSetting(): boolean {
    return process.env.EVER_WORKS_APP_WORKS_ENABLED === 'true';
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
 *
 * Two things changed here after the `/new` + `/works/new` server-render crash,
 * and both are load-bearing:
 *
 *  - The fail-CLOSED kinds are now seeded from
 *    {@link HIDDEN_WHEN_DISABLED_WORK_KINDS} itself, not from the fail-closed
 *    members of `values`. Seeding FROM the input made the guarantee depend on
 *    the input: a caller that passed `[]`, a subset, or something that is not an
 *    array at all silently received a set in which `app` was ENABLED — the exact
 *    opposite of fail-closed.
 *  - A `values` that is not an array is treated as EMPTY rather than iterated.
 *    That is a real input, not a hypothetical one: a server component importing
 *    this value from a `'use client'` module receives a client reference — an
 *    opaque placeholder — while TypeScript still types it as the array.
 *    `values.filter(…)` on it threw `TypeError: a.filter is not a function`
 *    during server render and 500'd both pages.
 */
export async function getDisabledWorkKinds(
    values: readonly string[],
    distinctId?: string,
    gate?: WorkKindFlagGate,
): Promise<Set<string>> {
    // A NON-array `values` is an observed input, not a hypothetical one: the
    // server pages used to pass the array they imported from a `'use client'`
    // module, and a server component receives a *client reference* there.
    // TypeScript cannot see that — the importing module types the binding as the
    // array — so the shape is checked at runtime and everything below runs over
    // `[]` when the check fails.
    const candidates: readonly string[] = Array.isArray(values) ? values : [];

    // Fail-CLOSED kinds start disabled: every path below (no client, error,
    // timeout, partial set) must leave them out of the picker, so the choice
    // is made here — before any evaluation — and only an explicit `true`
    // clears it. Seeded from the LIST rather than from `values`, so a caller
    // cannot weaken the guarantee by passing a short (or broken) argument.
    const disabled = new Set<string>([
        ...HIDDEN_WHEN_DISABLED_WORK_KINDS,
        ...candidates.filter((value) => FAIL_CLOSED.has(value)),
    ]);

    try {
        const client = getClient();
        if (!client) {
            // APW-01 T20 — with NO PostHog configured at all there is no flag to
            // consult, so the runtime instance setting decides. Without this the
            // fail-closed kinds were invisible on every install that has no
            // PostHog, including local development and the PR e2e lane, even
            // when the instance had switched the surface on.
            const instanceEnabled = gate?.appWorksEnabled ?? readAppWorksInstanceSetting();
            if (instanceEnabled === true) {
                for (const value of candidates) {
                    if (FAIL_CLOSED.has(value)) disabled.delete(value);
                }
            }
            return disabled;
        }

        const id = distinctId ?? 'anonymous';
        const evaluate = Promise.all(
            candidates.map(async (value) => {
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
