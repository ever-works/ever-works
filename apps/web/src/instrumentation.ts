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
}
