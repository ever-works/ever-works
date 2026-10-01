import 'server-only';
import { PostHog } from 'posthog-node';

/**
 * The one server-side PostHog client the web's flag helpers share.
 *
 * Extracted from `./work-kinds.ts` (APW-12 T21) so the Ever ID flag helper can
 * evaluate its own flag without importing the Work-kind policy: the two helpers
 * read "no PostHog key" in opposite ways (Work kinds fail open, Ever ID lets the
 * configuration alone decide), so they share the client and nothing else.
 *
 * Semantics are exactly the ones `work-kinds.ts` had:
 *
 *   - **Module-level singleton** — a client is never constructed per request.
 *   - `null` once it has been decided that there is no `POSTHOG_API_KEY`, so the
 *     environment is not re-read on every call. A suite that flips the key
 *     between cases must re-import the module (`vi.resetModules()`), as the
 *     work-kinds spec already does.
 *   - `POSTHOG_HOST` defaults to `https://app.posthog.com`.
 */

// `null` = no key configured (decided once), `undefined` = not yet initialised.
let cachedClient: PostHog | null | undefined;

export function getPostHogClient(): PostHog | null {
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
