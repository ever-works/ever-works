import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { UserRepository } from '@ever-works/agent/database';
import { AuthSession } from '@ever-works/agent/entities';
import type { TokenResponse } from '../types/auth.types';
import { AUTH_PROVIDER } from '../providers/auth-provider.constants';
import { AuthProvider } from '../providers/auth-provider.abstract';

/**
 * H-01 (sessions): mirror the helper used by `AuthProviderService`. We
 * hash the raw bearer with sha256 at write time and only ever look up by
 * the hash. Tokens carry 256 bits of entropy so an unsalted sha256 is
 * collision-free for our purposes.
 */
function hashSessionToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * EW-617 G2 — Anonymous (zero-friction) user creation.
 *
 * Spawns a fresh `User` row with `isAnonymous=true` + a TTL, then issues an
 * `AuthSession` token so the rest of the API treats them like any other
 * authenticated user. No email/password is collected. The row + its Works
 * are wiped by the `anonymous-user-cleanup` Trigger.dev schedule once the
 * TTL elapses.
 *
 * Claim-account (EW-617 G3) flips `isAnonymous=false`, clears the TTL,
 * and attaches credentials.
 */
@Injectable()
export class AnonymousAuthService {
    private readonly logger = new Logger(AnonymousAuthService.name);

    constructor(
        private readonly userRepository: UserRepository,
        @InjectDataSource() private readonly dataSource: DataSource,
        @Inject(AUTH_PROVIDER)
        private readonly authProvider: AuthProvider,
    ) {}

    /**
     * H-05: anonymous TTL is the window during which an attacker rotating
     * IPv6 /64s can cheaply manufacture sessions. Default dropped from 7
     * days to 3 days (still gives a real user a long weekend to claim);
     * operators can override via `ANONYMOUS_USER_TTL_DAYS`.
     */
    private getTtlMs(): number {
        const days = Number(process.env.ANONYMOUS_USER_TTL_DAYS || '3');
        if (!Number.isFinite(days) || days <= 0) {
            return 3 * 24 * 60 * 60 * 1000;
        }
        return days * 24 * 60 * 60 * 1000;
    }

    async createAnonymousUser(
        opts: {
            ipAddress?: string | null;
            userAgent?: string | null;
        } = {},
    ): Promise<TokenResponse> {
        const expiresAt = new Date(Date.now() + this.getTtlMs());
        const username = `anon-${randomBytes(4).toString('hex')}`;

        const user = await this.userRepository.create({
            username,
            email: null,
            password: null,
            isAnonymous: true,
            anonymousExpiresAt: expiresAt,
            registrationProvider: 'anonymous',
            emailVerified: false,
            isActive: true,
        });

        this.logger.log(
            `anonymous user created id=${user.id} username=${username} expiresAt=${expiresAt.toISOString()}`,
        );

        // Mint a session token directly — Better Auth's signup flow requires
        // an email/password, so we bypass it for anon users and write the
        // session row by hand. Same shape the rest of the API consumes.
        //
        // H-01 (sessions): the raw token is returned to the caller as
        // `access_token`; the persisted row stores `null` in the legacy
        // `token` column and `sha256(rawToken)` in `tokenHash`. Lookup on
        // every authenticated request goes through `tokenHash` only.
        const rawToken = randomBytes(32).toString('base64url');
        await this.dataSource.getRepository(AuthSession).save({
            id: randomUUID(),
            userId: user.id,
            token: null,
            tokenHash: hashSessionToken(rawToken),
            expiresAt,
            ipAddress: opts.ipAddress ?? null,
            userAgent: opts.userAgent ?? null,
        });

        return {
            access_token: rawToken,
            user: {
                id: user.id,
                email: null,
                username: user.username,
                isAnonymous: true,
                anonymousExpiresAt: expiresAt.toISOString(),
            },
        };
    }
}
