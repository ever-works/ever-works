/**
 * Jest stub for the ESM-only `better-auth/plugins`, used by the DI-compile
 * lane (`jest.di.config.js`) only. Mirrors the inline
 * `jest.mock('better-auth/plugins', ...)` in
 * `src/auth/providers/auth-runtime.instance.spec.ts`.
 */
export function bearer(): Record<string, unknown> {
    return { id: 'bearer' };
}
