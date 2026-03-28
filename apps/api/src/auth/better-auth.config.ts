import { betterAuth } from 'better-auth';
import { typeormAdapter } from 'better-auth-typeorm-adapter';
import { DataSource } from 'typeorm';
import { config, AuthProvider } from '../config/constants';
import { GITHUB_SCOPES } from './config/github-scopes.config';
import { BaUser, BaSession, BaAccount, BaVerification } from '@ever-works/agent/entities';
import { UserRepository, OAuthTokenRepository } from '@ever-works/agent/database';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserConfirmedEvent } from '../events';
import { Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

const logger = new Logger('BetterAuth');

export interface BetterAuthDeps {
    dataSource: DataSource;
    userRepository: UserRepository;
    oauthTokenRepository: OAuthTokenRepository;
    eventEmitter: EventEmitter2;
}

export function createBetterAuthInstance(deps: BetterAuthDeps) {
    const { dataSource, userRepository, oauthTokenRepository, eventEmitter } = deps;
    const webAppUrl = config.webAppUrl();

    return betterAuth({
        appName: config.branding.appName(),
        baseURL: config.betterAuth.url(),
        basePath: '/api/auth/better-auth',
        secret: config.betterAuth.secret(),

        database: typeormAdapter({
            dataSource,
            entities: {
                user: BaUser,
                session: BaSession,
                account: BaAccount,
                verification: BaVerification,
            },
        }),

        emailAndPassword: {
            enabled: true,
            requireEmailVerification: false,
            minPasswordLength: 8,
            autoSignIn: true,
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
            },
        },

        socialProviders: {
            ...(config.github.clientId() && {
                github: {
                    clientId: config.github.clientId()!,
                    clientSecret: config.github.clientSecret()!,
                    scope: [...GITHUB_SCOPES],
                },
            }),
            ...(config.google.clientId() && {
                google: {
                    clientId: config.google.clientId()!,
                    clientSecret: config.google.clientSecret()!,
                    accessType: 'offline' as const,
                },
            }),
            ...(config.linkedin.clientId() && {
                linkedin: {
                    clientId: config.linkedin.clientId()!,
                    clientSecret: config.linkedin.clientSecret()!,
                },
            }),
            ...(config.facebook.clientId() && {
                facebook: {
                    clientId: config.facebook.clientId()!,
                    clientSecret: config.facebook.clientSecret()!,
                },
            }),
            ...(config.twitter.clientId() && {
                twitter: {
                    clientId: config.twitter.clientId()!,
                    clientSecret: config.twitter.clientSecret()!,
                },
            }),
        },

        databaseHooks: {
            user: {
                create: {
                    after: async (baUser) => {
                        // Sync new BetterAuth user to application users table
                        try {
                            // Check if user already exists by ID or email
                            const existingById = await userRepository.findById(baUser.id);
                            if (existingById) {
                                logger.log(`User ${baUser.id} already exists in application table`);
                                return;
                            }

                            const existingByEmail = await userRepository.findByEmail(baUser.email);
                            if (existingByEmail) {
                                // User exists with different ID (registered via old auth system)
                                // Link the existing user — no need to create a new one
                                logger.log(
                                    `User with email ${baUser.email} already exists (id: ${existingByEmail.id}), skipping create`,
                                );
                                return;
                            }

                            // Truly new user — create in application table
                            const randomPassword = await bcrypt.hash(
                                randomBytes(16).toString('hex'),
                                10,
                            );

                            await userRepository.create({
                                id: baUser.id,
                                username: baUser.name || baUser.email.split('@')[0],
                                email: baUser.email,
                                password: randomPassword,
                                registrationProvider: AuthProvider.LOCAL,
                                emailVerified: baUser.emailVerified || false,
                                avatar: baUser.image || undefined,
                                isActive: true,
                            } as any);

                            logger.log(`Synced new user to application table: ${baUser.id}`);

                            // Emit welcome event for OAuth users (email verified = true)
                            if (baUser.emailVerified) {
                                const user = await userRepository.findById(baUser.id);
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
                                `Failed to sync user ${baUser.id} to application table:`,
                                error,
                            );
                        }
                    },
                },
            },
            account: {
                create: {
                    after: async (account) => {
                        // Sync OAuth accounts to oauth_tokens table (for plugin system)
                        if (account.providerId === 'credential') return;

                        try {
                            // BetterAuth may have created the user with a new UUID,
                            // but the application users table may have the same email
                            // under a different ID. Find the correct application user ID.
                            let appUserId = account.userId;
                            const userById = await userRepository.findById(account.userId);
                            if (!userById) {
                                // BetterAuth user ID doesn't exist in users table —
                                // find by email via the ba_user table
                                const baUserRepo = dataSource.getRepository(BaUser);
                                const baUser = await baUserRepo.findOne({
                                    where: { id: account.userId },
                                });
                                if (baUser) {
                                    const existingUser = await userRepository.findByEmail(
                                        baUser.email,
                                    );
                                    if (existingUser) {
                                        appUserId = existingUser.id;
                                    } else {
                                        logger.warn(
                                            `No application user found for BetterAuth user ${account.userId} (${baUser.email})`,
                                        );
                                        return;
                                    }
                                }
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
                                    syncedFromBetterAuth: true,
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
                            // Find the correct application user (may differ from BetterAuth user ID)
                            let appUserId = session.userId;
                            const userById = await userRepository.findById(session.userId);
                            if (!userById) {
                                const baUserRepo = dataSource.getRepository(BaUser);
                                const baUser = await baUserRepo.findOne({
                                    where: { id: session.userId },
                                });
                                if (baUser) {
                                    const existingUser = await userRepository.findByEmail(
                                        baUser.email,
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

export type BetterAuthInstance = ReturnType<typeof createBetterAuthInstance>;
