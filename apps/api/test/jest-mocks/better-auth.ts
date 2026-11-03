/**
 * Jest stub for the ESM-only `better-auth`, used by the DI-compile lane
 * (`jest.di.config.js`) only. Mirrors what
 * `src/auth/providers/auth-runtime.instance.spec.ts` already does with an
 * inline `jest.mock('better-auth', ...)`.
 *
 * See `README.md` in this directory for why substituting it cannot mask the
 * defect that lane exists to catch.
 */
export type BetterAuthOptions = Record<string, unknown>;

export function betterAuth(options: BetterAuthOptions): Record<string, unknown> {
    return {
        options,
        api: {},
        handler: async () => new Response(null, { status: 501 }),
    };
}
