import { betterAuth } from 'better-auth';
import { typeormAdapter } from 'better-auth-typeorm-adapter';
import { DataSource } from 'typeorm';
import { config, AuthProvider } from '../config/constants';
import { GITHUB_SCOPES } from './config/github-scopes.config';
import { AuthUser, AuthSession, AuthAccount, AuthVerification } from '@ever-works/agent/entities';
import { UserRepository, OAuthTokenRepository } from '@ever-works/agent/database';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserConfirmedEvent, UserCreatedEvent, UserForgotPasswordEvent } from '../events';
import { Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

const logger = new Logger('AuthProvider');

export interface AuthProviderDeps {
    dataSource: DataSource;
    userRepository: UserRepository;
    oauthTokenRepository: OAuthTokenRepository;
    eventEmitter: EventEmitter2;
}

export function createAuthProviderInstance(deps: AuthProviderDeps) {
    const { dataSource, userRepository, oauthTokenRepository, eventEmitter } = deps;
    const webAppUrl = config.webAppUrl();

    return betterAuth({
        appName: config.branding.appName(),
        baseURL: config.authProvider.url(),
        basePath: '/api/auth/provider',
        secret: config.authProvider.secret(),

        database: typeormAdapter({
            dataSource,
            entities: {
                user: AuthUser,
                session: AuthSession,
                account: AuthAccount,
                verification: AuthVerification,
            },
        }),

        emailAndPassword: {
            enabled: true,
            requireEmailVerification: false,
            minPasswordLength: 8,
            autoSignIn: true,
            sendResetPassword: async ({ user, url, token }) => {
                const appUser =
                    (await userRepository.findById(user.id)) ||
                    (await userRepository.findByEmail(user.email));

                if (!appUser) {
                    logger.warn(
                        `Unable to send provider password reset email for unknown user ${user.email}`,
                    );
                    return;
                }

                eventEmitter.emit(
                    UserForgotPasswordEvent.EVENT_NAME,
                    new UserForgotPasswordEvent(appUser, token, url, '1 hour'),
                );
            },
            onPasswordReset: async ({ user }) => {
                const authAccountRepository = dataSource.getRepository(AuthAccount);
                const credentialAccount = await authAccountRepository.findOne({
                    where: {
                        userId: user.id,
                        providerId: 'credential',
                    },
                });

                if (!credentialAccount?.password) {
                    logger.warn(
                        `Unable to sync provider password reset for user ${user.id}: credential account missing`,
                    );
                    return;
                }

                const appUser =
                    (await userRepository.findById(user.id)) ||
                    (await userRepository.findByEmail(user.email));

                if (!appUser) {
                    logger.warn(
                        `Unable to sync provider password reset for unknown user ${user.email}`,
                    );
                    return;
                }

                await userRepository.update(appUser.id, {
                    password: credentialAccount.password,
                    passwordResetToken: null,
                    passwordResetExpires: null,
                });
            },
            password: {
                // Use same bcrypt config as existing system for compatibility
                hash: async (password: string) => {
                    return bcrypt.hash(password, 10);
                },
                verify: async ({ hash, password }: { hash: string; password: string }) => {
                    return bcrypt.compare(password, hash);
                },
            },
        },

        emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: true,
            sendVerificationEmail: async ({ user, url, token }) => {
                const appUser =
                    (await userRepository.findById(user.id)) ||
                    (await userRepository.findByEmail(user.email));

                if (!appUser) {
                    logger.warn(
                        `Unable to send provider verification email for unknown user ${user.email}`,
                    );
                    return;
                }

                eventEmitter.emit(
                    UserCreatedEvent.EVENT_NAME,
                    new UserCreatedEvent(appUser, token, url),
                );
            },
            afterEmailVerification: async (user) => {
                const appUser =
                    (await userRepository.findById(user.id)) ||
                    (await userRepository.findByEmail(user.email));

                if (!appUser) {
                    logger.warn(
                        `Unable to handle afterEmailVerification for unknown user ${user.email}`,
                    );
                    return;
                }

                eventEmitter.emit(
                    UserConfirmedEvent.EVENT_NAME,
                    new UserConfirmedEvent(appUser, `${webAppUrl}/directories/new`),
                );
            },
        },

        session: {
            expiresIn: 60 * 60 * 24 * 7, // 7 days
            updateAge: 60 * 60 * 24, // 1 day
            cookieCache: {
                enabled: true,
                maxAge: 60 * 5, // 5 minutes — avoids DB lookup on every request
            },
        },

        account: {
            accountLinking: {
                enabled: true,
                // The GitHub connect step is an explicit authenticated linking flow.
                // We require GitHub for git-backed features even when the user's
                // primary account was created with a different email provider.
                allowDifferentEmails: true,
            },
        },

        socialProviders: {
            ...(config.github.clientId() && config.github.clientSecret() && {
                github: {
                    clientId: config.github.clientId()!,
                    clientSecret: config.github.clientSecret()!,
                    prompt: 'select_account' as const,
                    scope: [...GITHUB_SCOPES],
                },
            }),
            ...(config.google.clientId() && config.google.clientSecret() && {
                google: {
                    clientId: config.google.clientId()!,
                    clientSecret: config.google.clientSecret()!,
                    prompt: 'select_account consent' as const,
                    accessType: 'offline' as const,
                },
            }),
            ...(config.linkedin.clientId() && config.linkedin.clientSecret() && {
                linkedin: {
                    clientId: config.linkedin.clientId()!,
                    clientSecret: config.linkedin.clientSecret()!,
                },
            }),
            ...(config.facebook.clientId() && config.facebook.clientSecret() && {
                facebook: {
                    clientId: config.facebook.clientId()!,
                    clientSecret: config.facebook.clientSecret()!,
                },
            }),
            ...(config.twitter.clientId() && config.twitter.clientSecret() && {
                twitter: {
                    clientId: config.twitter.clientId()!,
                    clientSecret: config.twitter.clientSecret()!,
                },
            }),
        },

        databaseHooks: {
            user: {
                create: {
                    after: async (authUser) => {
                        // Sync new auth-provider user to application users table
                        try {
                            // Check if user already exists by ID or email
                            const existingById = await userRepository.findById(authUser.id);
                            if (existingById) {
                                logger.log(
                                    `User ${authUser.id} already exists in application table`,
                                );
                                return;
                            }

                            const existingByEmail = await userRepository.findByEmail(
                                authUser.email,
                            );
                            if (existingByEmail) {
                            // User exists with different ID (registered via old auth system)
                            // Link the existing user — no need to create a new one
                                logger.log(
                                    `User with email ${authUser.email} already exists (id: ${existingByEmail.id}), skipping create`,
                                );
                                return;
                            }

                            // Truly new user — create in application table
                            const randomPassword = await bcrypt.hash(
                                randomBytes(16).toString('hex'),
                                10,
                            );

                            await userRepository.create({
                                id: authUser.id,
                                username: authUser.name || authUser.email.split('@')[0],
                                email: authUser.email,
                                password: randomPassword,
                                registrationProvider: AuthProvider.LOCAL,
                                emailVerified: authUser.emailVerified || false,
                                avatar: authUser.image || undefined,
                                isActive: true,
                            } as any);

                            logger.log(`Synced new user to application table: ${authUser.id}`);

                            // Emit welcome event for OAuth users (email verified = true)
                            if (authUser.emailVerified) {
                                const user = await userRepository.findById(authUser.id);
                                if (user) {
                                    eventEmitter.emit(
                                        UserConfirmedEvent.EVENT_NAME,
                                        new UserConfirmedEvent(
                                            user,
                                            `${webAppUrl}/directories/new`,
                                        ),
                                    );
                                }
                            }
                        } catch (error) {
                            logger.error(
                                `Failed to sync user ${authUser.id} to application table:`,
                                error,
                            );
                        }
                    },
                },
            },
            account: {
                create: {
                    after: async (account) => {
                        try {
                            // The auth provider may have created the user with a new UUID,
                            // but the application users table may have the same email
                            // under a different ID. Find the correct application user ID.
                            let appUserId = account.userId;
                            const userById = await userRepository.findById(account.userId);
                            if (!userById) {
                                const authUserRepo = dataSource.getRepository(AuthUser);
                                const authUser = await authUserRepo.findOne({
                                    where: { id: account.userId },
                                });
                                if (authUser) {
                                    const existingUser = await userRepository.findByEmail(
                                        authUser.email,
                                    );
                                    if (existingUser) {
                                        appUserId = existingUser.id;
                                    } else {
                                        logger.warn(
                                            `No application user found for auth provider user ${account.userId} (${authUser.email})`,
                                        );
                                        return;
                                    }
                                }
                            }

                            if (account.providerId === 'credential') {
                                await userRepository.update(appUserId, {
                                    password: account.password || undefined,
                                    registrationProvider: AuthProvider.LOCAL,
                                    lastLoginAt: new Date(),
                                });
                                return;
                            }

                            await oauthTokenRepository.upsert({
                                userId: appUserId,
                                provider: account.providerId,
                                accessToken: account.accessToken || '',
                                refreshToken: account.refreshToken || undefined,
                                tokenType: 'Bearer',
                                scope: account.scope || '',
                                expiresAt: account.accessTokenExpiresAt || undefined,
                                metadata: {
                                    accountId: account.accountId,
                                    syncedFromProvider: true,
                                },
                            });

                            // Update the user's registration provider
                            await userRepository.update(appUserId, {
                                registrationProvider: account.providerId,
                                lastLoginAt: new Date(),
                            });

                            logger.log(
                                `Synced ${account.providerId} account for user ${account.userId} to oauth_tokens`,
                            );
                        } catch (error) {
                            logger.error(
                                `Failed to sync account ${account.providerId} for user ${account.userId}:`,
                                error,
                            );
                        }
                    },
                },
            },
            session: {
                create: {
                    after: async (session) => {
                        // Update lastLoginAt on the application user
                        try {
                            // Find the correct application user (may differ from auth provider user ID)
                            let appUserId = session.userId;
                            const userById = await userRepository.findById(session.userId);
                            if (!userById) {
                                const authUserRepo = dataSource.getRepository(AuthUser);
                                const authUser = await authUserRepo.findOne({
                                    where: { id: session.userId },
                                });
                                if (authUser) {
                                    const existingUser = await userRepository.findByEmail(
                                        authUser.email,
                                    );
                                    if (existingUser) {
                                        appUserId = existingUser.id;
                                    }
                                }
                            }

                            await userRepository.update(appUserId, {
                                lastLoginAt: new Date(),
                                lastLoginIp: session.ipAddress || undefined,
                            });
                        } catch (error) {
                            logger.error(
                                `Failed to update lastLoginAt for user ${session.userId}:`,
                                error,
                            );
                        }
                    },
                },
            },
        },

        trustedOrigins: [config.webAppUrl()],

        advanced: {
            database: {
                generateId: 'uuid',
            },
        },
    });
}

export type AuthProviderInstance = ReturnType<typeof createAuthProviderInstance>;
