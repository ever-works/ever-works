import { existsSync, readFileSync } from 'node:fs';

/**
 * Credentials of the test user registered by `global-setup.ts`. Read
 * back by spec processes that need to `loginViaAPI` for a bearer token
 * — the bare `helpers/test-user.ts` module is NOT a safe source for
 * those creds because every worker / spec file evaluates its
 * `Date.now()` suffix independently (each Playwright worker is its own
 * Node process). global-setup writes this file alongside the
 * storageState; tests read it via `loadSeededTestUser()`.
 */
export interface SeededTestUser {
    name: string;
    email: string;
    password: string;
}

const CREDENTIALS_FILE = 'e2e/.auth/test-user.json';

let cached: SeededTestUser | undefined;

/**
 * Read the JSON file `global-setup.ts` writes after registering the
 * test user. Cached after the first read so repeat callers in the same
 * spec process don't re-stat the file. Throws a descriptive error if
 * the file is missing — the setup project must have run first.
 *
 * Falls back to env-var overrides (E2E_TEST_USER_EMAIL /
 * E2E_TEST_USER_PASSWORD) so operators running specs against a shared
 * staging environment can point at a pre-existing account without
 * re-running global-setup.
 */
export function loadSeededTestUser(): SeededTestUser {
    if (cached) return cached;

    const overrideEmail = process.env.E2E_TEST_USER_EMAIL;
    const overridePassword = process.env.E2E_TEST_USER_PASSWORD;
    if (overrideEmail && overridePassword) {
        cached = {
            name: process.env.E2E_TEST_USER_NAME ?? overrideEmail,
            email: overrideEmail,
            password: overridePassword,
        };
        return cached;
    }

    if (!existsSync(CREDENTIALS_FILE)) {
        throw new Error(
            `loadSeededTestUser: ${CREDENTIALS_FILE} not found. The "setup" Playwright project must run before specs that call this helper. Either run \`pnpm exec playwright test\` (which runs setup as a dependency project) or set E2E_TEST_USER_EMAIL + E2E_TEST_USER_PASSWORD to point at a pre-existing account.`,
        );
    }
    const raw = readFileSync(CREDENTIALS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SeededTestUser>;
    if (!parsed.email || !parsed.password) {
        throw new Error(
            `loadSeededTestUser: ${CREDENTIALS_FILE} is missing email or password fields. Re-run the setup project to regenerate.`,
        );
    }
    cached = {
        name: parsed.name ?? parsed.email,
        email: parsed.email,
        password: parsed.password,
    };
    return cached;
}
