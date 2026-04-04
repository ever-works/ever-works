import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { createPool } from 'mysql2/promise';
import { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { AUTH_RUNTIME_BASE_PATH } from './auth-provider.constants';
import { config, AuthProvider as RegistrationProvider } from '../../config/constants';

const AUTH_PROVIDER_PLACEHOLDER_PASSWORD_HASH =
    '$2b$10$3FpU5KTq.lf4tUSzT4i0JOuuywnxGPnkKorObPlIEG14V0wl17ANS';

function resolveSqliteDatabasePath() {
    const explicitPath = process.env.DATABASE_PATH;
    if (explicitPath && explicitPath !== ':memory:') {
        return explicitPath;
    }

    if (process.env.DATABASE_IN_MEMORY === 'true') {
        throw new Error(
            'Auth runtime requires a persistent shared database. In-memory SQLite is not supported.',
        );
    }

    const environment = process.env.NODE_ENV || 'development';
    const appType = process.env.APP_TYPE || 'api';

    if (appType === 'cli') {
        return path.join(os.homedir(), '.ever-works', 'ever-works.db');
    }

    if (environment === 'test') {
        return path.join(os.tmpdir(), 'ever-works-api.test.db');
    }

    return path.join(os.tmpdir(), 'ever-works-api.db');
}

function createDatabaseClient() {
    const dbUrl = process.env.DATABASE_URL;
    const dbType = process.env.DATABASE_TYPE || 'sqlite';

    if (dbUrl?.startsWith('postgres://') || dbUrl?.startsWith('postgresql://')) {
        return new Pool({ connectionString: dbUrl });
    }

    if (dbUrl?.startsWith('mysql://') || dbUrl?.startsWith('mariadb://')) {
        return createPool(dbUrl);
    }

    if (dbType.includes('postgres')) {
        return new Pool({
            host: process.env.DATABASE_HOST || 'localhost',
            port: parseInt(process.env.DATABASE_PORT || '5432', 10),
            user: process.env.DATABASE_USERNAME || 'postgres',
            password: process.env.DATABASE_PASSWORD || '',
            database: process.env.DATABASE_NAME || 'ever_works',
        });
    }

    if (dbType.includes('mysql') || dbType.includes('mariadb')) {
        return createPool({
            host: process.env.DATABASE_HOST || 'localhost',
            port: parseInt(process.env.DATABASE_PORT || '3306', 10),
            user: process.env.DATABASE_USERNAME || 'root',
            password: process.env.DATABASE_PASSWORD || '',
            database: process.env.DATABASE_NAME || 'ever_works',
        });
    }

    const sqlitePath = resolveSqliteDatabasePath();
    const sqliteDir = path.dirname(sqlitePath);
    if (!fs.existsSync(sqliteDir)) {
        fs.mkdirSync(sqliteDir, { recursive: true });
    }

    return new Database(sqlitePath);
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

export function createAuthRuntimeInstance() {
    const options: BetterAuthOptions = {
        database: createDatabaseClient(),
        baseURL:
            process.env.AUTH_URL ||
            process.env.BETTER_AUTH_URL ||
            `http://localhost:${process.env.PORT || 3100}${AUTH_RUNTIME_BASE_PATH}`,
        basePath: AUTH_RUNTIME_BASE_PATH,
        secret: config.auth.secret(),
        trustedOrigins: getTrustedOrigins(),
        advanced: {
            database: {
                generateId: 'uuid',
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
        session: {
            modelName: 'auth_sessions',
        },
        account: {
            modelName: 'auth_accounts',
            accountLinking: {
                enabled: true,
                trustedProviders: ['google', 'github', 'facebook', 'linkedin'],
            },
        },
        verification: {
            modelName: 'auth_verifications',
        },
        emailAndPassword: {
            enabled: true,
            autoSignIn: true,
            minPasswordLength: 8,
        },
        databaseHooks: {
            user: {
                create: {
                    before: async (user) => {
                        return {
                            data: {
                                ...user,
                                password: AUTH_PROVIDER_PLACEHOLDER_PASSWORD_HASH,
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
