import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { randomUUID } from 'node:crypto';
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

function getInitializedDatabaseClient(dataSource: DataSource): any {
    const driver = dataSource.driver as any;

    switch (dataSource.options.type) {
        case 'better-sqlite3':
            if (driver.databaseConnection) {
                return driver.databaseConnection;
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
        plugins: [bearer()],
    };

    return betterAuth(options);
}
