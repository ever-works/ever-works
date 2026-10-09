/**
 * The origin this deployment is served to browsers on.
 *
 * This MUST NOT be derived from the incoming `Request`. Inside a Next server
 * `request.url` is the server's own view of itself, never the browser-facing
 * URL: `attachRequestMeta` builds it from the bind hostname and port
 * (`http://<hostname>:<port>`), or leaves it relative — so it resolves against
 * Next's dummy `http://n` base — unless `experimental.trustHostHeader` is on,
 * which it is not. In production the app binds `process.env.HOSTNAME` (the k8s
 * pod name) and serves `https://app.ever.works` through an ingress, so:
 *
 *  - comparing a browser Referer against `new URL(request.url).origin` could
 *    never match and rejected EVERY call to every guarded route (EW e2e shards
 *    16 and 27, red since 2026-08-23 — see `lib/api/bff-scope.ts`);
 *  - a route-handler redirect built as `new URL(path, request.url)` sent the
 *    browser to `https://<pod-name>:3000/...` ("server IP address could not be
 *    found") — the GitHub App install callback, prod 2026-10-09.
 *
 * Middleware (`proxy.ts`) redirects are NOT affected: Next relativizes a
 * middleware `Location` against the request URL before sending it. Route
 * handlers get no such treatment, and `NextResponse.redirect` requires an
 * absolute URL.
 *
 * `WEB_URL` / `NEXT_PUBLIC_WEB_URL` is the deployment's public origin and is
 * already set wherever this runs (prod/stage/dev k8s manifests, the e2e
 * workflow). It is read per call rather than at module load so tests and env
 * changes are honoured. Never derived from `x-forwarded-host` — that header is
 * client-controllable.
 *
 * @returns the configured public origin, or `null` when none is configured.
 */
export function configuredPublicOrigin(): string | null {
    const configured = process.env.NEXT_PUBLIC_WEB_URL || process.env.WEB_URL;
    if (!configured) return null;
    try {
        return new URL(configured).origin;
    } catch {
        return null;
    }
}

/**
 * The browser-facing origin to build route-handler redirects on: the configured
 * public origin, falling back to the request's own origin ONLY when no public
 * origin is configured (a bare local `next dev`, where the two coincide).
 */
export function publicOriginFor(request: Request): string {
    return configuredPublicOrigin() ?? new URL(request.url).origin;
}

/**
 * Absolute URL for a same-deployment path on the browser-facing origin — the
 * replacement for `new URL(path, request.url)` in route-handler redirects.
 */
export function publicUrl(path: string, request: Request): URL {
    return new URL(path, publicOriginFor(request));
}
