import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { termsAcceptancePlugin } from 'terms-acceptance/better-auth';
import {
    TERMS_ACCEPTANCE_MODEL,
    getRequiredTermsDocuments,
} from '../../terms/terms-acceptance.corpus';
import { randomBytes, randomUUID } from 'node:crypto';
import { SqliteDialect, type SqliteDialectConfig } from 'kysely';
import { DataSource } from 'typeorm';
import { AUTH_RUNTIME_BASE_PATH } from './auth-provider.constants';
import { config, AuthProvider as RegistrationProvider } from '../../config/constants';
import * as bcrypt from 'bcrypt';

// L-07 bcrypt helpers re-exported from `./bcrypt-cost` so callers that
// don't want to load the ESM-only `better-auth/plugins` module (e.g.
// `auth-provider.service.spec.ts` with its mocked Better Auth) can import
// directly from `./bcrypt-cost`.
export {
    MIN_BCRYPT_COST,
    DEFAULT_BCRYPT_COST,
    getBcryptCost,
    parseBcryptCost,
    passwordNeedsRehash,
} from './bcrypt-cost';
import { getBcryptCost } from './bcrypt-cost';

/**
 * What Better Auth gets as `database` on better-sqlite3: a Kysely dialect over
 * TypeORM's own connection, with Better Auth's transactions turned off.
 *
 * TypeORM runs a better-sqlite3 DataSource on ONE connection, and it tracks
 * that connection's transaction state (`isTransactionActive`,
 * `transactionDepth`) on the one query runner every caller shares. Better
 * Auth >= 1.7 wraps sign-up and other multi-write calls in a transaction
 * whenever it is handed a raw better-sqlite3 handle, and issues its own
 * `begin` / `commit` / `rollback` on that same connection, which TypeORM never
 * sees. When a TypeORM transaction (the domain event relay's tick, any
 * `save()`) starts while a sign-up's transaction is open:
 *
 *  1. TypeORM's `BEGIN TRANSACTION` fails ("cannot start a transaction within
 *     a transaction");
 *  2. TypeORM's error path then issues `ROLLBACK`, which ends the sign-up's
 *     transaction, and leaves its own depth at -1;
 *  3. the sign-up's commit finds no transaction and its rollback fails with
 *     "cannot rollback - no transaction is active" (HTTP 500 on register);
 *  4. every later TypeORM transaction in the process issues
 *     `SAVEPOINT typeorm_-1` and fails with `near "-": syntax error`, and its
 *     error-path `ROLLBACK` ends whichever sign-up is open at that moment.
 *
 * Better Auth 1.6 never opened a transaction here, so `transaction: false`
 * restores exactly its behaviour: each Better Auth write is a single statement
 * on the shared connection (inside a TypeORM transaction when one is open, like
 * any other single statement on this driver), and Better Auth never issues
 * `begin` / `commit` / `rollback`. The cost, the same as on 1.6: on SQLite a
 * sign-up's user and credential-account inserts are not one atomic unit. The
 * dialect reuses TypeORM's connection, never a second one, because an
 * in-memory database exists only on the connection that created it. Postgres
 * and MySQL keep native transactions: Better Auth takes its own pooled
 * connection for each one, so TypeORM's state is never touched.
 */
function getSqliteDatabase(
    connection: SqliteDialectConfig['database'],
): BetterAuthOptions['database'] {
    return {
        dialect: new SqliteDialect({ database: connection }),
        type: 'sqlite',
        transaction: false,
    };
}

function getInitializedDatabaseClient(dataSource: DataSource): any {
    const driver = dataSource.driver as any;

    switch (dataSource.options.type) {
        case 'better-sqlite3':
            if (driver.databaseConnection) {
                return getSqliteDatabase(driver.databaseConnection);
            }
            break;
        case 'postgres':
            if (driver.master) {
                return driver.master;
            }
            break;
        case 'mysql':
        case 'mariadb':
            if (driver.pool) {
                return driver.pool;
            }
            break;
    }

    throw new Error(
        `Unable to resolve Better Auth database client from initialized TypeORM driver "${dataSource.options.type}".`,
    );
}

/**
 * EW-652 Phase 0 — mirrors `UsernameAllocatorService.normalize()` in
 * `apps/api/src/users/services/username-allocator.service.ts`, which is
 * the slug shape the `/api/users/check-username` preflight reports as
 * available. Keeping these in lockstep is load-bearing: a divergence
 * lets the preflight return `available: true` for a normalized name
 * whose actual Better Auth INSERT would then collide on the UNIQUE
 * `users.slug` constraint.
 *
 * The User entity's `@BeforeInsert deriveSlugIfMissing()` hook falls
 * back to the fixed string `u-anon`, but only one row in the entire
 * table can have that slug (UNIQUE). Subsequent degenerate-username
 * signups would collide there. Codex P2 on PR #1064: use a random
 * suffix here so degenerate names like `!!!` or `---` each get a
 * unique slug instead of all racing for the same `u-anon` row.
 */
function deriveSlugFromName(name: string | undefined | null): string {
    const fallback = (): string => `u-${randomBytes(4).toString('hex')}`;

    if (!name) {
        return fallback();
    }
    const normalized = name
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized.length > 0 ? normalized : fallback();
}

function getTrustedOrigins() {
    const origins = new Set<string>();
    const configuredOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];

    for (const origin of configuredOrigins) {
        const trimmedOrigin = origin.trim();
        if (trimmedOrigin) {
            origins.add(trimmedOrigin);
        }
    }

    origins.add(config.webAppUrl());

    return [...origins];
}

export function createAuthRuntimeInstance(dataSource: DataSource) {
    if (!dataSource.isInitialized) {
        throw new Error('Auth runtime requires an initialized TypeORM DataSource.');
    }

    const options: BetterAuthOptions = {
        database: getInitializedDatabaseClient(dataSource),
        baseURL:
            process.env.AUTH_URL ||
            `http://localhost:${process.env.PORT || 3100}${AUTH_RUNTIME_BASE_PATH}`,
        basePath: AUTH_RUNTIME_BASE_PATH,
        secret: config.auth.secret(),
        trustedOrigins: getTrustedOrigins(),
        advanced: {
            database: {
                // Generate the row id in JS as a UUID string.
                //
                // The previous value `'uuid'` is a sentinel that tells
                // `@better-auth/core/db/adapter/get-id-field.mjs` "the DB
                // adapter supports UUIDs natively, let it generate." On
                // Postgres (`supportsUUIDs=true`) better-auth then strips
                // `id` from the INSERT payload entirely, expecting a
                // `DEFAULT gen_random_uuid()` on the column. Our TypeORM
                // `AuthAccount` entity uses `@PrimaryColumn({ type: 'varchar' })`
                // with no default, so every `linkAccount` (the call path
                // every register hits) failed with `null value in column "id"
                // of relation "account" violates not-null constraint`.
                //
                // Passing a function bypasses the sentinel branch: better-auth
                // calls this generator on every create and injects the value
                // into the INSERT. Works on Postgres, sqlite, mysql alike,
                // and matches the UUID format already used by the User
                // entity's `@PrimaryGeneratedColumn('uuid')`.
                generateId: () => randomUUID(),
                // Better Auth >=1.7.3 compares the live schema with the fields
                // it writes, once per process, and every `auth.api.*` call
                // (sign-up, sign-in, getSession, sign-out) awaits that verdict.
                // A mismatch rejects them all with `SCHEMA_MISMATCH`, not just
                // the insert that would have failed. TypeORM owns these tables,
                // so a migration on `users`, `account`, `session`,
                // `verification` or `terms_acceptance` must keep two rules:
                // every column Better Auth writes (the core fields plus the
                // `additionalFields` below) exists, and every column it does
                // not write is nullable or has a default. On a mismatch the
                // API still starts and readiness stays green (it does not run
                // this check): Better Auth logs the findings as an error when
                // the instance is created at boot, then rejects the affected
                // calls. Keep it on so drift names its columns instead of
                // surfacing as a 422 on the next signup; set it to `false` only
                // as an emergency switch.
                validateSchema: true,
            },
        },
        user: {
            modelName: 'users',
            fields: {
                name: 'username',
                image: 'avatar',
            },
            additionalFields: {
                password: {
                    type: 'string',
                    input: false,
                    required: false,
                },
                registrationProvider: {
                    type: 'string',
                    input: false,
                    required: false,
                    defaultValue: RegistrationProvider.LOCAL,
                },
                isActive: {
                    type: 'boolean',
                    input: false,
                    required: false,
                    defaultValue: true,
                },
                lastLoginAt: {
                    type: 'date',
                    input: false,
                    required: false,
                },
                lastLoginIp: {
                    type: 'string',
                    input: false,
                    required: false,
                },
                committerName: {
                    type: 'string',
                    input: false,
                    required: false,
                },
                committerEmail: {
                    type: 'string',
                    input: false,
                    required: false,
                },
                // EW-652 (Tenants & Organizations Phase 0) — `users.slug` is
                // a NOT NULL UNIQUE column added by
                // `1779991001000-AddSlugToUsers.ts`. Better Auth writes through
                // its own DB adapter (raw SQL via the Postgres pool extracted
                // from TypeORM), which bypasses the User entity's
                // `@BeforeInsert deriveSlugIfMissing()` hook — so without an
                // explicit `slug` value the INSERT fails with
                // `null value in column "slug" violates not-null constraint`
                // and Better Auth wraps it as `FAILED_TO_CREATE_USER` (HTTP
                // 422 "Failed to create user"). Declaring it here as an
                // additional field with `input: false` lets the `before`
                // hook below populate it before the INSERT runs.
                slug: {
                    type: 'string',
                    input: false,
                    required: false,
                },
            },
        },
        account: {
            accountLinking: {
                enabled: true,
                // M-01: Facebook is removed from trustedProviders. Facebook
                // hard-codes `emailVerified: false` for its profile responses
                // (see social-auth.service.ts), so a Facebook account with a
                // forged/unverified email could otherwise auto-link to a
                // pre-existing local account with the same email. LinkedIn
                // and Google verify emails server-side; GitHub OAuth's
                // primary email is verified server-side via the GitHub API.
                trustedProviders: ['google', 'github', 'linkedin'],
            },
        },
        emailAndPassword: {
            enabled: true,
            // H-07: require email verification before the user can sign in.
            // Combined with C-02 (no verification token in HTTP response),
            // this closes the loop where an attacker registers with a victim's
            // email and immediately gains an authenticated session. Existing
            // unverified users will be prompted to verify on next login
            // (the platform currently has very few users, all internal).
            // Env-overridable for E2E + local-dev: `REQUIRE_EMAIL_VERIFICATION=false`
            // turns off the check so test flows can register + login in one go.
            // Default stays `true` so production deploys can't accidentally
            // disable the check by omission.
            autoSignIn: true,
            requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION !== 'false',
            minPasswordLength: 8,
            password: {
                // L-07: cost is read on each call so operators can raise it
                // via `BCRYPT_COST` without a redeploy of this file. New
                // users / password resets immediately get hashes at the new
                // cost; existing users migrate transparently via the
                // rehash-on-login branch in `AuthProviderService.signInEmail`.
                hash: async (password: string) => {
                    return bcrypt.hash(password, getBcryptCost());
                },
                verify: async ({ hash, password }: { hash: string; password: string }) => {
                    return bcrypt.compare(password, hash);
                },
            },
        },
        databaseHooks: {
            user: {
                create: {
                    before: async (user) => {
                        return {
                            data: {
                                ...user,
                                // L-07: same configured cost as `password.hash` above.
                                password: await bcrypt.hash(randomUUID(), getBcryptCost()),
                                registrationProvider: RegistrationProvider.LOCAL,
                                isActive: true,
                                // EW-652 Phase 0 — derive the URL-safe `slug`
                                // from the username. Mirrors the User
                                // entity's `@BeforeInsert deriveSlugIfMissing()`,
                                // which is bypassed because Better Auth
                                // INSERTs through its own DB adapter rather
                                // than the TypeORM repository. The DB UNIQUE
                                // constraint on `slug` is the final
                                // authority — racing duplicates will surface
                                // as 422 to the caller, same as a duplicate
                                // username. Better Auth applies its
                                // `user.fields.name → username` mapping
                                // before invoking this hook, so the column
                                // name is available either as `username`
                                // (post-mapping) or as the original `name`
                                // (depending on adapter internals); we read
                                // both for robustness across Better Auth
                                // versions.
                                slug: deriveSlugFromName(
                                    (user as { username?: string }).username ??
                                        (user as { name?: string }).name,
                                ),
                            },
                        };
                    },
                },
            },
        },
        socialProviders: {
            ...(config.google.clientId() && config.google.clientSecret()
                ? {
                      google: {
                          clientId: config.google.clientId()!,
                          clientSecret: config.google.clientSecret()!,
                      },
                  }
                : {}),
            ...(config.github.clientId() && config.github.clientSecret()
                ? {
                      github: {
                          clientId: config.github.clientId()!,
                          clientSecret: config.github.clientSecret()!,
                      },
                  }
                : {}),
            ...(config.facebook.clientId() && config.facebook.clientSecret()
                ? {
                      facebook: {
                          clientId: config.facebook.clientId()!,
                          clientSecret: config.facebook.clientSecret()!,
                      },
                  }
                : {}),
            ...(config.linkedin.clientId() && config.linkedin.clientSecret()
                ? {
                      linkedin: {
                          clientId: config.linkedin.clientId()!,
                          clientSecret: config.linkedin.clientSecret()!,
                      },
                  }
                : {}),
        },
        plugins: [
            bearer(),
            // Declares the `terms_acceptance` model so Better Auth's own
            // database layer knows the table and its columns, and so
            // `better-auth generate` stays in step with the TypeORM migration
            // (1785000000000-CreateTermsAcceptance) that actually creates it.
            //
            // `createAuthEndpoint` / `sessionMiddleware` are deliberately NOT
            // passed: the plugin's built-in `/terms-acceptance/*` routes require
            // a session, and the case being fixed here is signup — where no
            // session exists yet. Registration records through
            // `TermsAcceptanceService` on the API's own `/auth/register` path
            // instead, and this plugin contributes the schema and the adapter.
            termsAcceptancePlugin({
                required: () => getRequiredTermsDocuments(),
                model: TERMS_ACCEPTANCE_MODEL,
                ipSalt: process.env.TERMS_IP_SALT,
            }),
        ],
    };

    return betterAuth(options);
}
