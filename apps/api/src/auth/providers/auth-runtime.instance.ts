import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { DataSource } from 'typeorm';
import { AUTH_RUNTIME_BASE_PATH } from './auth-provider.constants';
import { config, AuthProvider as RegistrationProvider } from '../../config/constants';
import * as bcrypt from 'bcrypt';

const AUTH_PROVIDER_PLACEHOLDER_PASSWORD_HASH =
    '$2b$10$3FpU5KTq.lf4tUSzT4i0JOuuywnxGPnkKorObPlIEG14V0wl17ANS';

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
        account: {
            accountLinking: {
                enabled: true,
                trustedProviders: ['google', 'github', 'facebook', 'linkedin'],
            },
        },
        emailAndPassword: {
            enabled: true,
            autoSignIn: true,
            minPasswordLength: 8,
            password: {
                hash: async (password: string) => {
                    return bcrypt.hash(password, 10);
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
