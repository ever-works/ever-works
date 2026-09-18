import 'server-only';
import { PostHog } from 'posthog-node';
import { API_URL } from '@/lib/constants';

/**
 * APW-11 (App Launcher) — whether this deployment shows the launcher at all
 * (FR-54, FR-65, ACC-11-28).
 *
 * ## Fail CLOSED, unlike its sibling
 *
 * {@link getDisabledWorkKinds} in `./work-kinds.ts` fails **open**: an OSS
 * deployment with no PostHog gets every work kind, because a missing
 * experiment must not remove a feature. This helper is the opposite on
 * purpose. The App Launcher is switched off by default per installation, so
 * "we could not tell" has to mean **off**: a launcher that appeared because a
 * flag service was slow would be a feature nobody turned on.
 *
 * ## Both halves must agree
 *
 *   - the **API's** answer, read from `GET /api/config`'s
 *     `features.appLauncherEnabled`, and
 *   - the **PostHog** flag `app-launcher` for this person, when PostHog is
 *     configured at all.
 *
 * The API half is read over HTTP rather than from this process's environment
 * on purpose (APW11-G12): the web and the API are separate deployments, and a
 * web-side copy of `EVER_WORKS_LAUNCHER_ENABLED` would drift from the API's
 * answer — showing a surface the API answers 404 for, or hiding one it serves.
 *
 * ## The budget
 *
 * Both halves are capped at 1,500 ms, the same cap `./work-kinds.ts` uses, so a
 * slow flag service can never hold up a page render. A timeout, a non-200, a
 * parse error, a missing flag (`undefined`) and a thrown error all resolve to
 * `false`. PostHog **not being configured** is the one case that is not a
 * failure: an OSS deployment with no PostHog key still gets the launcher when
 * its own installation switch says so.
 */

/** Flag key. Named once so a caller can reference it without re-typing it. */
export const APP_LAUNCHER_FLAG_KEY = 'app-launcher';

/** Hard cap for each half — a slow dependency must not block a render. */
const APP_LAUNCHER_FLAG_BUDGET_MS = 1500;

// Module-level singleton, exactly as `./work-kinds.ts` does it: never
// construct a client per request. `null` = no key configured (decided once),
// `undefined` = not yet initialised.
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
 * The API's answer. `false` on anything that is not a `200` carrying
 * `features.appLauncherEnabled === true`.
 */
async function readApiSwitch(): Promise<boolean> {
    try {
        const response = await fetch(`${API_URL}/config`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(APP_LAUNCHER_FLAG_BUDGET_MS),
        });

        if (!response.ok) {
            return false;
        }

        const body = (await response.json()) as {
            features?: { appLauncherEnabled?: unknown };
        };

        return body?.features?.appLauncherEnabled === true;
    } catch {
        // Unreachable, timed out, or not JSON. "We could not tell" is OFF.
        return false;
    }
}

/**
 * The experiment half. `true` only when PostHog is configured AND resolves the
 * flag to `true` within the budget; an unconfigured PostHog abstains (`true`)
 * so the installation switch alone decides.
 */
async function readFlag(distinctId: string): Promise<boolean> {
    const client = getClient();
    if (!client) {
        return true;
    }

    try {
        const evaluation = client
            .isFeatureEnabled(APP_LAUNCHER_FLAG_KEY, distinctId, {
                sendFeatureFlagEvents: false,
            })
            .then((value) => value === true);

        const timeout = new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(false), APP_LAUNCHER_FLAG_BUDGET_MS);
        });

        return await Promise.race([evaluation, timeout]);
    } catch {
        return false;
    }
}

/**
 * Whether to render the launcher for this person.
 *
 * NEVER throws — a page render must not depend on a flag service.
 */
export async function isAppLauncherEnabled(distinctId?: string): Promise<boolean> {
    const installationEnabled = await readApiSwitch();
    if (!installationEnabled) {
        return false;
    }

    return readFlag(distinctId ?? 'anonymous');
}
