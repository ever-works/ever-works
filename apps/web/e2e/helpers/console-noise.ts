/**
 * Console-noise filter for the e2e harness.
 *
 * The Playwright config (apps/web/playwright.config.ts) stamps an
 * `x-e2e-throttle-key` request header on EVERY request so the API's
 * `UserAwareThrottlerGuard` can bucket rate-limits per Playwright worker
 * instead of per shared CI-runner IP (otherwise sibling workers saturate one
 * IP bucket and a legitimate seed bounces 429).
 *
 * Browsers replay `extraHTTPHeaders` on cross-origin sub-resource fetches too,
 * and a custom (non-CORS-safelisted) header turns those fetches into
 * preflighted requests. Third-party CDNs we legitimately load from — e.g.
 * `cdn.jsdelivr.net`, which serves the dotLottie WASM player used on the auth
 * pages — do not list `x-e2e-throttle-key` in `Access-Control-Allow-Headers`,
 * so the preflight is rejected and the browser logs a CORS `console.error`.
 *
 * This is a pure TEST-HARNESS artifact: the throttle-key header is hard-gated
 * off in production (both the Playwright config and the guard only act outside
 * `NODE_ENV=production`), so a real user never sends it and never sees this
 * error. Console-hygiene specs must therefore ignore any console message that
 * mentions our own injected header.
 */
export function isThrottleKeyCorsNoise(text: string): boolean {
    return /x-e2e-throttle-key/i.test(text);
}
