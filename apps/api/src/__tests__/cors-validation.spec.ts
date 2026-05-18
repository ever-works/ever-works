import { assertProductionCorsConfig } from '../cors-validation';

/**
 * H-19 — boot-time CORS fail-fast.
 *
 * `assertProductionCorsConfig` is extracted from `main.ts` so the
 * production-only guard can be asserted without spinning up a NestJS app.
 * If this guard regresses, a production deploy with an unset
 * `ALLOWED_ORIGINS` would silently fall back to a localhost-only allow-list
 * while still serving `credentials: true` — which is both useless to real
 * callers and a foot-gun for any future change that drops the credentials
 * flag (see `apps/api/src/cors-validation.ts` for the full rationale).
 */
describe('assertProductionCorsConfig (H-19)', () => {
    it('throws with a clear message when NODE_ENV=production and ALLOWED_ORIGINS is empty', () => {
        // Both unset and empty-string must throw — both are "no origins
        // configured" from the caller's perspective.
        for (const allowedOrigins of [undefined, '', '   ', ',,,', '  ,  ,  ']) {
            const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
            if (allowedOrigins !== undefined) {
                env.ALLOWED_ORIGINS = allowedOrigins;
            }

            expect(() => assertProductionCorsConfig(env)).toThrow(/ALLOWED_ORIGINS/);
            expect(() => assertProductionCorsConfig(env)).toThrow(/production/);
        }
    });

    it('does NOT throw when NODE_ENV=production and ALLOWED_ORIGINS has at least one origin', () => {
        const env: NodeJS.ProcessEnv = {
            NODE_ENV: 'production',
            ALLOWED_ORIGINS: 'https://x.com',
        };

        expect(() => assertProductionCorsConfig(env)).not.toThrow();
        expect(assertProductionCorsConfig(env)).toEqual(['https://x.com']);
    });

    it('parses a comma-separated origin list, trimming whitespace and dropping empty entries', () => {
        const env: NodeJS.ProcessEnv = {
            NODE_ENV: 'production',
            // Real-world copy-paste: trailing commas, padded whitespace,
            // empty fragments. All of these must be normalized away.
            ALLOWED_ORIGINS: ' https://app.ever.works , , https://demo.ever.works ,  ',
        };

        expect(assertProductionCorsConfig(env)).toEqual([
            'https://app.ever.works',
            'https://demo.ever.works',
        ]);
    });

    it('does NOT throw in development when ALLOWED_ORIGINS is empty (dev fallback is intentional)', () => {
        // Dev/preview: an unset list is fine — the caller falls back to
        // localhost:3000, which is the correct default for that environment.
        for (const env of [
            { NODE_ENV: 'development' } as NodeJS.ProcessEnv,
            { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
            { NODE_ENV: undefined as unknown as string } as NodeJS.ProcessEnv,
            { NODE_ENV: 'development', ALLOWED_ORIGINS: '' } as NodeJS.ProcessEnv,
            { NODE_ENV: 'development', ALLOWED_ORIGINS: ',  ,' } as NodeJS.ProcessEnv,
        ]) {
            expect(() => assertProductionCorsConfig(env)).not.toThrow();
        }
    });

    it('returns undefined when ALLOWED_ORIGINS is unset (caller falls back to localhost)', () => {
        const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
        expect(assertProductionCorsConfig(env)).toBeUndefined();
    });

    it('does NOT throw in development even when configured (does not affect non-production behaviour)', () => {
        // Sanity check: the guard is production-only — a dev env with an
        // explicit list still works.
        const env: NodeJS.ProcessEnv = {
            NODE_ENV: 'development',
            ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:3001',
        };
        expect(() => assertProductionCorsConfig(env)).not.toThrow();
        expect(assertProductionCorsConfig(env)).toEqual([
            'http://localhost:3000',
            'http://localhost:3001',
        ]);
    });
});
