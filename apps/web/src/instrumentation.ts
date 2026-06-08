// Next.js boot hook. Runs once per worker before any request is served,
// in both the Node.js and Edge runtimes.
//
// H-14: surface an undersized AUTH_SECRET (`COOKIE_SECRET` or `AUTH_SECRET`)
// at boot instead of mid-OAuth-callback. `apps/web/src/lib/auth/crypto.ts`
// fails closed when the secret is shorter than 32 chars (after H-14 removed
// the constant-padding fallback), so a short secret used to silently break
// every social login the first time `setAuthAccessCookie` ran — the
// 2026-05-18 incident. Failing the boot makes the misconfiguration loud
// and stops the rollout instead.

export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return;

    const secret = process.env.COOKIE_SECRET || process.env.AUTH_SECRET;
    if (!secret) {
        throw new Error(
            'COOKIE_SECRET or AUTH_SECRET environment variable is required for cookie encryption.',
        );
    }
    if (secret.length < 32) {
        throw new Error(
            'COOKIE_SECRET / AUTH_SECRET must be at least 32 characters of high-entropy material ' +
                '(e.g. `openssl rand -base64 48`). The previous behavior of padding short secrets ' +
                'with a fixed string has been removed because it produced a predictable encryption ' +
                'key, and the OAuth callback handler now fails closed if the secret is too short.',
        );
    }

    // ALLOWED_REDIRECT_URLS: in production this env var has no safe default.
    // `lib/constants.ts` falls back to `localhost,127.0.0.1` when it is unset,
    // which means `addSessionTokenToUrl` silently refuses to attach session
    // tokens to any real (non-loopback) production redirect target. Warn (not
    // throw) at boot so the misconfiguration is loud in the logs without
    // breaking deploys that intentionally rely on loopback-only redirects.
    if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_REDIRECT_URLS) {
        console.warn(
            '[security] ALLOWED_REDIRECT_URLS is not set — defaulting to localhost,127.0.0.1. ' +
                'Set this to your production domain(s) or session tokens will not be appended to ' +
                'any absolute redirect URL.',
        );
    }
}
