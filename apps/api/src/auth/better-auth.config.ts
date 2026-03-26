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
            minPasswordLength: 6,
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
                            const existing = await userRepository.findById(baUser.id);
                            if (!existing) {
                                // Generate a random hashed password for the users table
                                // (actual password is stored in ba_account)
                                const randomPassword = await bcrypt.hash(
                                    require('crypto').randomBytes(16).toString('hex'),
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
                            await oauthTokenRepository.upsert({
                                userId: account.userId,
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
                            await userRepository.update(account.userId, {
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
                            await userRepository.update(session.userId, {
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

        advanced: {
            database: {
                generateId: 'uuid',
            },
        },
    });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuthInstance>;
