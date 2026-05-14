/**
 * Unit suite for `createAuthRuntimeInstance` — pins the option object
 * we hand to `better-auth` (`betterAuth(options)`) for every supported
 * TypeORM driver, the bcrypt hash/verify wiring, the Better Auth
 * `databaseHooks.user.create.before` synthetic-password +
 * `registrationProvider:'local'` + `isActive:true` invariant, the
 * conditional `socialProviders` registration (Google/GitHub/Facebook/
 * LinkedIn — only when BOTH client id AND secret are set), and the
 * `getTrustedOrigins` env parse + `webAppUrl()` injection.
 *
 * Mocks `better-auth` (`betterAuth` captures its options arg, returns a
 * sentinel), `better-auth/plugins` (`bearer()` returns a sentinel), and
 * `bcrypt` (`hash`/`compare` are jest.fn() so we can assert the
 * `(password, 10)` salt-rounds invariant + the verify call shape). No
 * real DB driver is constructed.
 */

const betterAuthMock = jest.fn().mockReturnValue({ __betterAuthInstance: true });
const bearerMock = jest.fn().mockReturnValue({ __bearerPlugin: true });

jest.mock('better-auth', () => ({
    betterAuth: betterAuthMock,
}));
jest.mock('better-auth/plugins', () => ({
    bearer: bearerMock,
}));

const bcryptHash = jest.fn();
const bcryptCompare = jest.fn();
jest.mock('bcrypt', () => ({
    hash: (...args: unknown[]) => bcryptHash(...args),
    compare: (...args: unknown[]) => bcryptCompare(...args),
}));

const randomUUIDMock = jest.fn();
jest.mock('node:crypto', () => ({
    ...jest.requireActual('node:crypto'),
    randomUUID: () => randomUUIDMock(),
}));

import { createAuthRuntimeInstance } from './auth-runtime.instance';
import { AUTH_RUNTIME_BASE_PATH } from './auth-provider.constants';
import { AuthProvider as RegistrationProvider } from '../../config/constants';

type AnyDataSource = {
    isInitialized: boolean;
    options: { type: string };
    driver: Record<string, unknown>;
};

function makeDataSource(type: string, driver: Record<string, unknown>): AnyDataSource {
    return {
        isInitialized: true,
        options: { type },
        driver,
    };
}

function getCapturedOptions() {
    expect(betterAuthMock).toHaveBeenCalledTimes(1);
    return betterAuthMock.mock.calls[0][0] as Record<string, any>;
}

const SOCIAL_ENV_KEYS = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GH_CLIENT_ID',
    'GH_CLIENT_SECRET',
    'FACEBOOK_CLIENT_ID',
    'FACEBOOK_CLIENT_SECRET',
    'LINKEDIN_CLIENT_ID',
    'LINKEDIN_CLIENT_SECRET',
] as const;

const RUNTIME_ENV_KEYS = ['AUTH_SECRET', 'AUTH_URL', 'PORT', 'WEB_URL', 'ALLOWED_ORIGINS'] as const;

describe('createAuthRuntimeInstance', () => {
    const ORIGINAL_ENV = { ...process.env };

    beforeEach(() => {
        // Reset env to a known baseline. AUTH_SECRET is required by config.auth.secret().
        for (const key of [...SOCIAL_ENV_KEYS, ...RUNTIME_ENV_KEYS]) {
            delete process.env[key];
        }
        process.env.AUTH_SECRET = 'test-secret';

        betterAuthMock.mockClear();
        betterAuthMock.mockReturnValue({ __betterAuthInstance: true });
        bearerMock.mockClear();
        bearerMock.mockReturnValue({ __bearerPlugin: true });
        bcryptHash.mockReset();
        bcryptCompare.mockReset();
        randomUUIDMock.mockReset();
    });

    afterAll(() => {
        for (const k of Object.keys(process.env)) {
            if (!(k in ORIGINAL_ENV)) delete process.env[k];
        }
        Object.assign(process.env, ORIGINAL_ENV);
    });

    describe('initialization guard', () => {
        it('throws when DataSource is not initialized', () => {
            const ds = makeDataSource('postgres', { master: {} }) as AnyDataSource;
            ds.isInitialized = false;

            expect(() => createAuthRuntimeInstance(ds as any)).toThrow(
                'Auth runtime requires an initialized TypeORM DataSource.',
            );
            expect(betterAuthMock).not.toHaveBeenCalled();
        });

        it('forwards the captured options object to `betterAuth` and returns its result', () => {
            const sentinel = { __sentinel: 'instance' };
            betterAuthMock.mockReturnValueOnce(sentinel);

            const ds = makeDataSource('postgres', { master: { id: 'pg-master' } });
            const result = createAuthRuntimeInstance(ds as any);

            expect(result).toBe(sentinel);
            expect(betterAuthMock).toHaveBeenCalledTimes(1);
        });
    });

    describe('database client resolution', () => {
        it('uses `driver.databaseConnection` for `better-sqlite3`', () => {
            const conn = { kind: 'sqlite' };
            const ds = makeDataSource('better-sqlite3', { databaseConnection: conn });

            createAuthRuntimeInstance(ds as any);

            expect(getCapturedOptions().database).toBe(conn);
        });

        it('uses `driver.master` for `postgres`', () => {
            const master = { kind: 'pg-master' };
            const ds = makeDataSource('postgres', { master });

            createAuthRuntimeInstance(ds as any);

            expect(getCapturedOptions().database).toBe(master);
        });

        it('uses `driver.pool` for `mysql`', () => {
            const pool = { kind: 'mysql-pool' };
            const ds = makeDataSource('mysql', { pool });

            createAuthRuntimeInstance(ds as any);

            expect(getCapturedOptions().database).toBe(pool);
        });

        it('uses `driver.pool` for `mariadb`', () => {
            const pool = { kind: 'mariadb-pool' };
            const ds = makeDataSource('mariadb', { pool });

            createAuthRuntimeInstance(ds as any);

            expect(getCapturedOptions().database).toBe(pool);
        });

        it('throws when the postgres driver has no `master` field', () => {
            const ds = makeDataSource('postgres', {});

            expect(() => createAuthRuntimeInstance(ds as any)).toThrow(
                'Unable to resolve Better Auth database client from initialized TypeORM driver "postgres".',
            );
        });

        it('throws when the better-sqlite3 driver has no `databaseConnection` field', () => {
            const ds = makeDataSource('better-sqlite3', {});

            expect(() => createAuthRuntimeInstance(ds as any)).toThrow(
                'Unable to resolve Better Auth database client from initialized TypeORM driver "better-sqlite3".',
            );
        });

        it('throws when the mysql driver has no `pool` field', () => {
            const ds = makeDataSource('mysql', {});

            expect(() => createAuthRuntimeInstance(ds as any)).toThrow(
                'Unable to resolve Better Auth database client from initialized TypeORM driver "mysql".',
            );
        });

        it('throws for an unsupported driver type', () => {
            const ds = makeDataSource('oracle', { someField: 1 });

            expect(() => createAuthRuntimeInstance(ds as any)).toThrow(
                'Unable to resolve Better Auth database client from initialized TypeORM driver "oracle".',
            );
            expect(betterAuthMock).not.toHaveBeenCalled();
        });
    });

    describe('baseURL + basePath', () => {
        it('uses `AUTH_URL` env var verbatim when set (overrides PORT)', () => {
            process.env.AUTH_URL = 'https://auth.example.com/runtime';
            process.env.PORT = '4000';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(getCapturedOptions().baseURL).toBe('https://auth.example.com/runtime');
        });

        it('falls back to `http://localhost:${PORT}${AUTH_RUNTIME_BASE_PATH}` when AUTH_URL is unset', () => {
            process.env.PORT = '4000';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(getCapturedOptions().baseURL).toBe(
                `http://localhost:4000${AUTH_RUNTIME_BASE_PATH}`,
            );
        });

        it('falls back to port 3100 when neither AUTH_URL nor PORT are set', () => {
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(getCapturedOptions().baseURL).toBe(
                `http://localhost:3100${AUTH_RUNTIME_BASE_PATH}`,
            );
        });

        it('always pins basePath to the `AUTH_RUNTIME_BASE_PATH` literal', () => {
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(getCapturedOptions().basePath).toBe(AUTH_RUNTIME_BASE_PATH);
            // Sanity check the literal has not silently moved.
            expect(AUTH_RUNTIME_BASE_PATH).toBe('/api/internal/auth-runtime');
        });
    });

    describe('secret', () => {
        it('reads from `config.auth.secret()` (delegates to AUTH_SECRET env var)', () => {
            process.env.AUTH_SECRET = 'sup3r-secret';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(getCapturedOptions().secret).toBe('sup3r-secret');
        });

        it('lets the `config.auth.secret()` AUTH_SECRET-required error propagate', () => {
            delete process.env.AUTH_SECRET;

            expect(() =>
                createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any),
            ).toThrow('AUTH_SECRET environment variable is required');
        });
    });

    describe('trustedOrigins', () => {
        it('always includes `config.webAppUrl()` (defaults to http://localhost:3000)', () => {
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const opts = getCapturedOptions();
            expect(opts.trustedOrigins).toEqual(['http://localhost:3000']);
        });

        it('includes `WEB_URL` when set', () => {
            process.env.WEB_URL = 'https://web.example.com';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(getCapturedOptions().trustedOrigins).toEqual(['https://web.example.com']);
        });

        it('parses `ALLOWED_ORIGINS` as a comma-separated list and trims whitespace', () => {
            process.env.ALLOWED_ORIGINS =
                'https://a.example, https://b.example , https://c.example';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const origins = getCapturedOptions().trustedOrigins as string[];
            expect(origins).toContain('https://a.example');
            expect(origins).toContain('https://b.example');
            expect(origins).toContain('https://c.example');
            expect(origins).toContain('http://localhost:3000');
        });

        it('drops empty entries from `ALLOWED_ORIGINS`', () => {
            process.env.ALLOWED_ORIGINS = ',https://a.example,, ,https://b.example,';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const origins = getCapturedOptions().trustedOrigins as string[];
            // Whitespace-only entries are filtered before adding.
            expect(origins).not.toContain('');
            expect(origins).not.toContain(' ');
            expect(origins).toContain('https://a.example');
            expect(origins).toContain('https://b.example');
        });

        it('deduplicates entries (Set semantics) — webAppUrl already in ALLOWED_ORIGINS appears once', () => {
            process.env.WEB_URL = 'https://app.example.com';
            process.env.ALLOWED_ORIGINS = 'https://app.example.com,https://other.example.com';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const origins = getCapturedOptions().trustedOrigins as string[];
            const occurrences = origins.filter((o) => o === 'https://app.example.com').length;
            expect(occurrences).toBe(1);
            expect(origins).toContain('https://other.example.com');
        });

        it('handles empty ALLOWED_ORIGINS string with only the webAppUrl entry', () => {
            process.env.ALLOWED_ORIGINS = '';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(getCapturedOptions().trustedOrigins).toEqual(['http://localhost:3000']);
        });
    });

    describe('advanced.database', () => {
        it('sets `generateId` to a function that delegates to node:crypto.randomUUID', () => {
            // Why a function and not the `'uuid'` sentinel: better-auth's
            // sentinel path strips the `id` from the INSERT payload on
            // Postgres (assuming a column-level DEFAULT), but our TypeORM
            // `AuthAccount` entity uses `@PrimaryColumn` with no default,
            // so the INSERT failed with `null value in column "id"`. A
            // function generator is invoked on every create and the value
            // is preserved through to the INSERT.
            randomUUIDMock
                .mockReturnValueOnce('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01')
                .mockReturnValueOnce('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02');
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const generateId = getCapturedOptions().advanced.database.generateId;
            expect(typeof generateId).toBe('function');

            // Each invocation produces a fresh UUID by calling
            // `node:crypto.randomUUID` (mocked above).
            expect(generateId()).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01');
            expect(generateId()).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee02');
        });
    });

    describe('user model', () => {
        it('points Better Auth at the `users` table', () => {
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(getCapturedOptions().user.modelName).toBe('users');
        });

        it('renames `name` → `username` and `image` → `avatar` to match the project schema', () => {
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const fields = getCapturedOptions().user.fields;
            expect(fields).toEqual({ name: 'username', image: 'avatar' });
        });

        it('declares the documented additionalFields with the correct shape and defaults', () => {
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const additionalFields = getCapturedOptions().user.additionalFields;

            // `password`: hashed credential, never accepted from input.
            expect(additionalFields.password).toEqual({
                type: 'string',
                input: false,
                required: false,
            });

            // `registrationProvider`: defaults to LOCAL on Better Auth-side create.
            expect(additionalFields.registrationProvider).toEqual({
                type: 'string',
                input: false,
                required: false,
                defaultValue: RegistrationProvider.LOCAL,
            });
            // `RegistrationProvider.LOCAL` is the wire-format string `'local'`.
            expect(RegistrationProvider.LOCAL).toBe('local');

            // `isActive`: defaults to true, NOT input-controllable.
            expect(additionalFields.isActive).toEqual({
                type: 'boolean',
                input: false,
                required: false,
                defaultValue: true,
            });

            // The four optional metadata fields are non-input + non-required.
            for (const key of ['lastLoginAt', 'lastLoginIp', 'committerName', 'committerEmail']) {
                expect(additionalFields[key].input).toBe(false);
                expect(additionalFields[key].required).toBe(false);
            }
            expect(additionalFields.lastLoginAt.type).toBe('date');
            expect(additionalFields.lastLoginIp.type).toBe('string');
            expect(additionalFields.committerName.type).toBe('string');
            expect(additionalFields.committerEmail.type).toBe('string');
        });

        it('declares exactly the seven documented additionalFields (regression guard)', () => {
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const keys = Object.keys(getCapturedOptions().user.additionalFields).sort();
            expect(keys).toEqual(
                [
                    'committerEmail',
                    'committerName',
                    'isActive',
                    'lastLoginAt',
                    'lastLoginIp',
                    'password',
                    'registrationProvider',
                ].sort(),
            );
        });
    });

    describe('account.accountLinking', () => {
        it('enables linking with the four documented trustedProviders', () => {
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(getCapturedOptions().account.accountLinking).toEqual({
                enabled: true,
                trustedProviders: ['google', 'github', 'facebook', 'linkedin'],
            });
        });
    });

    describe('emailAndPassword', () => {
        it('enables the email+password flow with the documented defaults', () => {
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const ep = getCapturedOptions().emailAndPassword;
            expect(ep.enabled).toBe(true);
            expect(ep.autoSignIn).toBe(true);
            expect(ep.minPasswordLength).toBe(8);
            expect(typeof ep.password.hash).toBe('function');
            expect(typeof ep.password.verify).toBe('function');
        });

        it('hashes via bcrypt with salt rounds = 10', async () => {
            bcryptHash.mockResolvedValueOnce('hashed-result');

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);
            const { hash } = getCapturedOptions().emailAndPassword.password;

            const result = await hash('plain-text');

            expect(bcryptHash).toHaveBeenCalledWith('plain-text', 10);
            expect(result).toBe('hashed-result');
        });

        it('verifies via bcrypt.compare with `(password, hash)` positional order', async () => {
            bcryptCompare.mockResolvedValueOnce(true);

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);
            const { verify } = getCapturedOptions().emailAndPassword.password;

            const ok = await verify({ hash: 'stored-hash', password: 'incoming' });

            // `bcrypt.compare(password, hash)` — NOT `(hash, password)`.
            expect(bcryptCompare).toHaveBeenCalledWith('incoming', 'stored-hash');
            expect(ok).toBe(true);
        });

        it('verify returns false when bcrypt.compare reports a mismatch', async () => {
            bcryptCompare.mockResolvedValueOnce(false);

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);
            const { verify } = getCapturedOptions().emailAndPassword.password;

            const ok = await verify({ hash: 'h', password: 'p' });

            expect(ok).toBe(false);
        });
    });

    describe('databaseHooks.user.create.before', () => {
        it('enriches the create payload with a hashed synthetic password + LOCAL provider + isActive=true', async () => {
            randomUUIDMock.mockReturnValueOnce('uuid-fixture');
            bcryptHash.mockResolvedValueOnce('hashed-uuid-fixture');

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);
            const before = getCapturedOptions().databaseHooks.user.create.before;

            const payload = await before({ id: 'u1', email: 'a@b.test', username: 'someone' });

            expect(payload).toEqual({
                data: {
                    id: 'u1',
                    email: 'a@b.test',
                    username: 'someone',
                    password: 'hashed-uuid-fixture',
                    registrationProvider: RegistrationProvider.LOCAL,
                    isActive: true,
                },
            });
            expect(bcryptHash).toHaveBeenCalledWith('uuid-fixture', 10);
            expect(randomUUIDMock).toHaveBeenCalledTimes(1);
        });

        it('overrides any caller-supplied password/registrationProvider/isActive with the synthetic values (spread order)', async () => {
            randomUUIDMock.mockReturnValueOnce('uuid-2');
            bcryptHash.mockResolvedValueOnce('hashed-uuid-2');

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);
            const before = getCapturedOptions().databaseHooks.user.create.before;

            const payload = await before({
                id: 'u2',
                password: 'caller-supplied',
                registrationProvider: 'github',
                isActive: false,
            });

            expect(payload.data.password).toBe('hashed-uuid-2');
            expect(payload.data.registrationProvider).toBe(RegistrationProvider.LOCAL);
            expect(payload.data.isActive).toBe(true);
        });

        it('issues a fresh synthetic password per call (UUID per invocation)', async () => {
            randomUUIDMock.mockReturnValueOnce('uuid-A').mockReturnValueOnce('uuid-B');
            bcryptHash.mockResolvedValueOnce('h-A').mockResolvedValueOnce('h-B');

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);
            const before = getCapturedOptions().databaseHooks.user.create.before;

            const a = await before({ id: 'a' });
            const b = await before({ id: 'b' });

            expect(a.data.password).toBe('h-A');
            expect(b.data.password).toBe('h-B');
            expect(bcryptHash).toHaveBeenNthCalledWith(1, 'uuid-A', 10);
            expect(bcryptHash).toHaveBeenNthCalledWith(2, 'uuid-B', 10);
        });
    });

    describe('socialProviders', () => {
        it('omits all four providers when none of the env vars are set', () => {
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(getCapturedOptions().socialProviders).toEqual({});
        });

        it('registers `google` only when BOTH GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set', () => {
            process.env.GOOGLE_CLIENT_ID = 'g-id';
            process.env.GOOGLE_CLIENT_SECRET = 'g-secret';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const socials = getCapturedOptions().socialProviders;
            expect(socials.google).toEqual({ clientId: 'g-id', clientSecret: 'g-secret' });
            expect(socials.github).toBeUndefined();
        });

        it('omits `google` when only GOOGLE_CLIENT_ID is set (secret missing)', () => {
            process.env.GOOGLE_CLIENT_ID = 'g-id';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(getCapturedOptions().socialProviders.google).toBeUndefined();
        });

        it('omits `google` when only GOOGLE_CLIENT_SECRET is set (id missing)', () => {
            process.env.GOOGLE_CLIENT_SECRET = 'g-secret';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(getCapturedOptions().socialProviders.google).toBeUndefined();
        });

        it('registers `github` from `GH_CLIENT_ID` + `GH_CLIENT_SECRET` (NOT GITHUB_*)', () => {
            process.env.GH_CLIENT_ID = 'gh-id';
            process.env.GH_CLIENT_SECRET = 'gh-secret';
            // Confirm the unrelated GITHUB_* envs do NOT trip the registration.
            process.env.GITHUB_CLIENT_ID = 'must-be-ignored';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const socials = getCapturedOptions().socialProviders;
            expect(socials.github).toEqual({ clientId: 'gh-id', clientSecret: 'gh-secret' });
        });

        it('registers `facebook` only when BOTH env vars are set', () => {
            process.env.FACEBOOK_CLIENT_ID = 'fb-id';
            process.env.FACEBOOK_CLIENT_SECRET = 'fb-secret';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const socials = getCapturedOptions().socialProviders;
            expect(socials.facebook).toEqual({ clientId: 'fb-id', clientSecret: 'fb-secret' });
        });

        it('registers `linkedin` only when BOTH env vars are set', () => {
            process.env.LINKEDIN_CLIENT_ID = 'li-id';
            process.env.LINKEDIN_CLIENT_SECRET = 'li-secret';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const socials = getCapturedOptions().socialProviders;
            expect(socials.linkedin).toEqual({ clientId: 'li-id', clientSecret: 'li-secret' });
        });

        it('registers all four providers concurrently when every env pair is set', () => {
            process.env.GOOGLE_CLIENT_ID = 'g-id';
            process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
            process.env.GH_CLIENT_ID = 'gh-id';
            process.env.GH_CLIENT_SECRET = 'gh-secret';
            process.env.FACEBOOK_CLIENT_ID = 'fb-id';
            process.env.FACEBOOK_CLIENT_SECRET = 'fb-secret';
            process.env.LINKEDIN_CLIENT_ID = 'li-id';
            process.env.LINKEDIN_CLIENT_SECRET = 'li-secret';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const socials = getCapturedOptions().socialProviders;
            expect(Object.keys(socials).sort()).toEqual(
                ['google', 'github', 'facebook', 'linkedin'].sort(),
            );
            expect(socials.google.clientId).toBe('g-id');
            expect(socials.github.clientId).toBe('gh-id');
            expect(socials.facebook.clientId).toBe('fb-id');
            expect(socials.linkedin.clientId).toBe('li-id');
        });

        it('treats empty-string env vars as missing (falsy short-circuit)', () => {
            process.env.GOOGLE_CLIENT_ID = '';
            process.env.GOOGLE_CLIENT_SECRET = 'g-secret';

            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(getCapturedOptions().socialProviders.google).toBeUndefined();
        });
    });

    describe('plugins', () => {
        it('registers exactly one bearer plugin via `bearer()`', () => {
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(bearerMock).toHaveBeenCalledTimes(1);
            const plugins = getCapturedOptions().plugins;
            expect(Array.isArray(plugins)).toBe(true);
            expect(plugins).toHaveLength(1);
            expect(plugins[0]).toEqual({ __bearerPlugin: true });
        });

        it('calls `bearer()` with no arguments', () => {
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            expect(bearerMock).toHaveBeenCalledWith();
        });
    });

    describe('captured options shape (regression guard)', () => {
        it('exposes the exact set of top-level option keys that Better Auth understands', () => {
            createAuthRuntimeInstance(makeDataSource('postgres', { master: {} }) as any);

            const keys = Object.keys(getCapturedOptions()).sort();
            expect(keys).toEqual(
                [
                    'account',
                    'advanced',
                    'basePath',
                    'baseURL',
                    'database',
                    'databaseHooks',
                    'emailAndPassword',
                    'plugins',
                    'secret',
                    'socialProviders',
                    'trustedOrigins',
                    'user',
                ].sort(),
            );
        });
    });
});
