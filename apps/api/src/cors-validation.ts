/**
 * H-19 — fail-fast CORS allow-list validation, extracted from `main.ts` so
 * the boot-time check is unit-testable without standing up a real NestJS app.
 *
 * Without this guard, a misconfigured preview/prod deploy would silently fall
 * back to a localhost-only allow-list while still serving `credentials: true`
 * — useless to real callers, and a foot-gun for any future change that drops
 * the credentials flag (legitimate cross-origin browsers would then be free
 * to hit the API anyway).
 *
 * @param env  An environment record. Defaults to `process.env`. Tests pass
 *             a synthetic record so they don't have to mutate global state.
 * @returns    The parsed, trimmed allow-list, or `undefined` when
 *             `ALLOWED_ORIGINS` is unset. The caller hands this straight to
 *             `app.enableCors({ origin })`.
 * @throws    `Error` when `NODE_ENV === 'production'` and the resulting
 *            allow-list is empty.
 */
export function assertProductionCorsConfig(
    env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
    const allowedOrigins = env.ALLOWED_ORIGINS?.split(',')
        .map((o) => o.trim())
        .filter(Boolean);
    if (env.NODE_ENV === 'production' && (!allowedOrigins || allowedOrigins.length === 0)) {
        throw new Error(
            'ALLOWED_ORIGINS must be configured in production. ' +
                'Set it to a comma-separated list of origins permitted to call the API with credentials, e.g. ' +
                '"https://app.ever.works,https://demo.ever.works".',
        );
    }
    return allowedOrigins;
}
