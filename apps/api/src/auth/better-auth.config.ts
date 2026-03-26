import { betterAuth } from 'better-auth';
import { typeormAdapter } from 'better-auth-typeorm-adapter';
import { DataSource } from 'typeorm';
import { config } from '../config/constants';
import { GITHUB_SCOPES } from './config/github-scopes.config';
import { BaUser, BaSession, BaAccount, BaVerification } from '@ever-works/agent/entities';

export function createBetterAuthInstance(dataSource: DataSource) {
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

        advanced: {
            database: {
                generateId: 'uuid',
            },
        },
    });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuthInstance>;
