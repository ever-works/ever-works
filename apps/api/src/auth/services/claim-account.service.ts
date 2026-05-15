import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { UserRepository } from '@ever-works/agent/database';
import { AUTH_PROVIDER } from '../providers/auth-provider.constants';
import { AuthProvider } from '../providers/auth-provider.abstract';
import { AuthSyncService } from '../providers/auth-sync.service';
import { AuthService } from './auth.service';

export interface ClaimAccountInput {
    userId: string;
    email: string;
    password: string;
    username?: string;
    emailVerificationCallbackUrl?: string;
}

/**
 * EW-617 G3 — Claim-Account flow.
 *
 * Converts an anonymous (zero-friction) `User` row into a regular,
 * credentialed account without losing any of their existing Works.
 *
 * Steps (all in one HTTP call):
 *  1. Verify the caller's session is anonymous (G2 introduced
 *     `is_anonymous`).
 *  2. Reject the request if the email is already taken by a different
 *     user. Policy: never auto-merge — that's a footgun. Ask the user
 *     to sign in with the existing account instead.
 *  3. Hash the password via the existing credential adapter
 *     (`AuthProvider.setPassword`) so the new account can sign in via
 *     `/login`.
 *  4. Flip `is_anonymous=false`, clear `anonymous_expires_at`, persist
 *     the email + (optional) new username, set
 *     `registration_provider='local'`.
 *  5. Delegate to `AuthService.sendVerificationEmail` so the
 *     verification mail goes through the existing pipeline.
 *
 * The original anon session token stays valid — the user remains
 * signed in. Works ownership is by `userId`, which doesn't change, so
 * no Work transfer step is needed.
 */
@Injectable()
export class ClaimAccountService {
    private readonly logger = new Logger(ClaimAccountService.name);

    constructor(
        private readonly userRepository: UserRepository,
        private readonly authSyncService: AuthSyncService,
        private readonly authService: AuthService,
        @Inject(AUTH_PROVIDER)
        private readonly authProvider: AuthProvider,
    ) {}

    async claim(input: ClaimAccountInput): Promise<{
        id: string;
        email: string;
        username: string;
        emailVerified: boolean;
    }> {
        const user = await this.userRepository.findById(input.userId);
        if (!user) {
            throw new NotFoundException('User not found');
        }

        if (!user.isAnonymous) {
            throw new ForbiddenException('Account is not anonymous');
        }

        const normalizedEmail = input.email.trim().toLowerCase();
        const existingByEmail = await this.userRepository.findByEmail(normalizedEmail);
        if (existingByEmail && existingByEmail.id !== user.id) {
            throw new ConflictException(
                'Email is already in use by another account. Please sign in with the existing account instead.',
            );
        }

        const username = input.username?.trim() || user.username;
        if (username.length < 3) {
            throw new BadRequestException('Username must be at least 3 characters');
        }

        // 1. Hash + persist credentials via Better Auth's adapter so the
        //    user can sign in via /api/auth/login like any other account.
        await this.authProvider.setPassword(user.id, input.password);
        const passwordHash = await this.authSyncService.getCredentialPasswordHash(user.id);
        if (!passwordHash) {
            throw new BadRequestException('Failed to attach credentials');
        }

        // 2. Flip the user out of anonymous mode in a single update so
        //    code racing on isAnonymous sees a consistent shape.
        const updated = await this.userRepository.update(user.id, {
            email: normalizedEmail,
            username,
            password: passwordHash,
            isAnonymous: false,
            anonymousExpiresAt: null,
            registrationProvider: 'local',
            emailVerified: false,
        });

        if (!updated) {
            throw new BadRequestException('Failed to update user');
        }

        // 3. Verification email goes through the existing pipeline.
        //    Catch here so a flaky mailer doesn't break the claim —
        //    the user can request a resend via /api/auth/send-verification.
        try {
            await this.authService.sendVerificationEmail(
                updated.id,
                input.emailVerificationCallbackUrl,
            );
        } catch (cause) {
            this.logger.warn(
                `Failed to send verification email for claimed user ${updated.id}: ${(cause as Error).message}`,
            );
        }

        this.logger.log(
            `anonymous user ${user.id} claimed account email=${normalizedEmail} username=${username}`,
        );

        return {
            id: updated.id,
            email: updated.email!,
            username: updated.username,
            emailVerified: updated.emailVerified,
        };
    }
}
