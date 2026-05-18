import {
    Injectable,
    ConflictException,
    UnauthorizedException,
    BadRequestException,
    Logger,
} from '@nestjs/common';
import { UserRepository, AuthAccountRepository } from '@ever-works/agent/database';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';

/**
 * H-01: derive a deterministic hash of a token for at-rest storage.
 * Verification/reset tokens travel out-of-band (via email) and need only
 * collision-free comparison on read, so a plain sha256 is correct (no salt
 * needed — the tokens themselves carry 256 bits of entropy).
 *
 * Operationally, this means: if the DB is leaked, the attacker gets hashes
 * not raw tokens, and cannot use them to take over accounts.
 */
function hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}
import { AuthProvider, config } from '../../config/constants';
import { getBcryptCost } from '../providers/bcrypt-cost';
import { User } from '@ever-works/agent/entities';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserCreatedEvent, UserConfirmedEvent, UserForgotPasswordEvent } from '../../events';
import { ForgotPasswordDto } from '../dto/email-verification.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import type { SocialAuthUser } from '../types/social-auth.types';

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    private webAppUrl: string;
    private allowedCallbackHosts: Set<string>;

    constructor(
        private readonly userRepository: UserRepository,
        private readonly authAccountRepository: AuthAccountRepository,
        private eventEmitter: EventEmitter2,
    ) {
        this.webAppUrl = config.webAppUrl();
        // C-04: parse ALLOWED_CALLBACK_HOSTS once at boot. The default always
        // includes the host of WEB_URL (`webAppUrl`) — that's the host the
        // platform itself emails links to. Operators can extend with their
        // CLI-domain / admin-domain etc.
        this.allowedCallbackHosts = this.parseAllowedCallbackHosts();
    }

    private parseAllowedCallbackHosts(): Set<string> {
        const hosts = new Set<string>();
        try {
            hosts.add(new URL(this.webAppUrl).host.toLowerCase());
        } catch {
            // webAppUrl validated elsewhere at boot
        }
        const env = process.env.ALLOWED_CALLBACK_HOSTS;
        if (env) {
            for (const raw of env.split(',')) {
                const v = raw.trim().toLowerCase();
                if (v) hosts.add(v);
            }
        }
        return hosts;
    }

    /**
     * C-04: enforce a host allow-list on user-supplied verify / reset
     * callback URLs. Without this, an attacker can pass
     * `emailVerificationCallbackUrl=https://attacker.example/steal` and the
     * platform will email the *victim* a link that exfiltrates the live
     * token to the attacker's host on click.
     *
     * Returns the callbackUrl if its host is allowed, otherwise returns
     * undefined so the caller falls back to the platform default.
     */
    private validateCallbackUrl(
        callbackUrl: string | undefined | null,
        kind: string,
    ): string | undefined {
        if (!callbackUrl) return undefined;
        let parsed: URL;
        try {
            parsed = new URL(callbackUrl);
        } catch {
            this.logger.warn(`Rejected ${kind} callbackUrl: not a valid URL (${callbackUrl})`);
            return undefined;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            this.logger.warn(`Rejected ${kind} callbackUrl: bad scheme (${parsed.protocol})`);
            return undefined;
        }
        if (!this.allowedCallbackHosts.has(parsed.host.toLowerCase())) {
            this.logger.warn(
                `Rejected ${kind} callbackUrl: host '${parsed.host}' is not in ALLOWED_CALLBACK_HOSTS`,
            );
            return undefined;
        }
        return callbackUrl;
    }

    async assertCanRegister(email: string) {
        const existingUser = await this.userRepository.findByEmail(email);
        if (existingUser) {
            throw new ConflictException('User with this email already exists');
        }
    }

    async validateSocialUser(socialUser: SocialAuthUser) {
        const isTrustedEmail = socialUser.emailVerified !== false;
        let user = await this.userRepository.findByEmail(socialUser.email);
        const displayName = socialUser.displayName || socialUser.email.split('@')[0];

        if (!user) {
            const hashedPassword = await this.randomHashedPassword();

            user = await this.userRepository.create({
                username: socialUser.username || displayName,
                email: socialUser.email,
                password: hashedPassword,
                registrationProvider: socialUser.provider,
                avatar: socialUser.avatar || undefined,
                emailVerified: isTrustedEmail,
                isActive: true,
                lastLoginAt: new Date(),
            });

            if (isTrustedEmail) {
                this.eventEmitter.emit(
                    UserConfirmedEvent.EVENT_NAME,
                    new UserConfirmedEvent(user, `${this.webAppUrl}/works/new`),
                );
            }
        } else {
            this.ensureUserIsActive(user);

            const existingProviderLink = await this.authAccountRepository.findProviderAccount(
                user.id,
                socialUser.provider,
            );
            if (!isTrustedEmail && !existingProviderLink) {
                throw new UnauthorizedException(
                    'Unable to link this social account because the provider email is not verified',
                );
            }

            user = await this.userRepository.update(user.id, {
                username: socialUser.username || user.username || displayName,
                avatar: socialUser.avatar || user.avatar,
                registrationProvider: socialUser.provider,
                emailVerified: user.emailVerified || isTrustedEmail,
                lastLoginAt: new Date(),
            });
        }

        await this.authAccountRepository.upsertProviderAccount({
            userId: user.id,
            providerId: socialUser.provider,
            accountId: socialUser.providerUserId,
            username: socialUser.username || undefined,
            email: socialUser.email,
            accessToken: socialUser.accessToken,
            refreshToken: socialUser.refreshToken || null,
            tokenType: socialUser.tokenType || 'Bearer',
            accessTokenExpiresAt: socialUser.expiresAt || null,
            scope: socialUser.scope || null,
            metadata: {
                providerUserId: socialUser.providerUserId,
                ...(socialUser.metadata || {}),
            },
        });

        return user;
    }

    async sendVerificationEmail(userId: string, callbackUrl?: string) {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new BadRequestException('User not found');
        }

        if (user.emailVerified) {
            throw new BadRequestException('Email already verified');
        }

        const verificationToken = randomBytes(32).toString('hex');
        const expires = new Date();
        expires.setHours(expires.getHours() + 24); // 24 hour expiry

        // H-01: persist sha256(token), email the raw token. The DB never
        // sees the value the user clicks; the column itself reuses the
        // existing `emailVerificationToken` name to avoid an entity migration
        // (column is now interpreted as "hashed token"). All
        // in-flight verification links issued before this deploy will fail
        // — by operator decision, see audit Q-8.
        await this.userRepository.update(userId, {
            emailVerificationToken: hashToken(verificationToken),
            emailVerificationExpires: expires,
        });

        // C-04: validate the caller-supplied callback host before stitching
        // the token into it; reject anything outside the allow-list and fall
        // back to the platform default.
        const validatedCallback = this.validateCallbackUrl(callbackUrl, 'verification');
        if (validatedCallback && !validatedCallback.includes('token=')) {
            callbackUrl = `${validatedCallback}?token=${verificationToken}`;
        } else {
            callbackUrl = `${this.webAppUrl}/api/auth/verify-email?token=${verificationToken}`;
        }

        // Emit event to send verification email — the token travels via the email link only.
        this.eventEmitter.emit(
            UserCreatedEvent.EVENT_NAME,
            new UserCreatedEvent(user, verificationToken, callbackUrl),
        );

        return {
            message: 'Verification email sent',
        };
    }

    async verifyEmail(token: string) {
        // H-01: lookup by sha256(submitted). DB stores hashes only.
        token = hashToken(token);
        const user = await this.userRepository.findOne({
            where: { emailVerificationToken: token },
        });

        if (!user) {
            throw new BadRequestException('Invalid verification token');
        }

        if (user.emailVerificationExpires && new Date() > user.emailVerificationExpires) {
            throw new BadRequestException('Verification token expired');
        }

        await this.userRepository.update(user.id, {
            emailVerified: true,
            emailVerificationToken: null,
            emailVerificationExpires: null,
        });

        // Get updated user data with emailVerified set to true
        const updatedUser = await this.userRepository.findById(user.id);
        if (!updatedUser) {
            throw new BadRequestException('User not found after verification');
        }

        // Send welcome email after email verification
        this.eventEmitter.emit(
            UserConfirmedEvent.EVENT_NAME,
            new UserConfirmedEvent(updatedUser, `${this.webAppUrl}/works/new`),
        );

        return updatedUser;
    }

    async forgotPassword(forgotPasswordDto: ForgotPasswordDto) {
        const user = await this.userRepository.findByEmail(forgotPasswordDto.email);
        if (!user) {
            // H-03: equalize the CPU cost of the no-user branch with the
            // user-exists branch so an attacker can't distinguish via timing.
            // The user-exists branch does a DB UPDATE that writes ~64 bytes
            // of indexed columns + emits an event; doing a throwaway bcrypt
            // here is a closer cost match than just returning immediately.
            // The bcrypt cost is pulled from `getBcryptCost()` so the no-user
            // branch matches whatever cost the user-exists branch uses for
            // password verification (see randomHashedPassword below).
            await this.randomHashedPassword().catch(() => undefined);
            return { message: 'If the email exists, a reset link has been sent' };
        }

        const resetToken = randomBytes(32).toString('hex');
        const expires = new Date();
        expires.setHours(expires.getHours() + 1); // 1 hour expiry

        // H-01: persist sha256(token), email the raw token. See sendVerificationEmail above.
        await this.userRepository.update(user.id, {
            passwordResetToken: hashToken(resetToken),
            passwordResetExpires: expires,
        });

        // C-04: validate the caller-supplied callback host before stitching
        // the reset token into it.
        const validatedReset = this.validateCallbackUrl(
            forgotPasswordDto.resetPasswordCallbackUrl,
            'reset-password',
        );
        let callbackUrl: string;
        if (validatedReset && !validatedReset.includes('token=')) {
            callbackUrl = `${validatedReset}?token=${resetToken}`;
        } else {
            callbackUrl = `${this.webAppUrl}/api/auth/reset-password?token=${resetToken}`;
        }

        // Emit event to send reset email — the token travels via the email link only.
        this.eventEmitter.emit(
            UserForgotPasswordEvent.EVENT_NAME,
            new UserForgotPasswordEvent(user, resetToken, callbackUrl, '1 hour'),
        );

        return {
            message: 'If the email exists, a reset link has been sent',
        };
    }

    async getUserByPasswordResetToken(token: string) {
        // H-01: lookup by sha256(submitted). DB stores hashes only.
        const tokenHash = hashToken(token);
        const user = await this.userRepository.findOne({
            where: { passwordResetToken: tokenHash },
        });

        if (!user) {
            throw new BadRequestException('Invalid reset token');
        }

        if (user.passwordResetExpires && new Date() > user.passwordResetExpires) {
            throw new BadRequestException('Reset token expired');
        }

        return user;
    }

    async consumePasswordResetToken(token: string) {
        const user = await this.getUserByPasswordResetToken(token);

        // H-01: lookup by sha256(submitted). DB stores hashes only.
        const consumed = await this.userRepository.clearPasswordResetToken(
            user.id,
            hashToken(token),
        );
        if (!consumed) {
            throw new BadRequestException('Invalid reset token');
        }

        return user;
    }

    async getUser(userId: string): Promise<User | null> {
        return await this.userRepository.findById(userId);
    }

    async getUserProfile(userId: string) {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new BadRequestException('User not found');
        }

        // Return user data without sensitive fields
        const {
            password,
            emailVerificationToken,
            emailVerificationExpires,
            passwordResetToken,
            passwordResetExpires,
            ...userProfile
        } = user;

        // Get connected providers from account records
        const providerAccounts =
            await this.authAccountRepository.findProviderAccountsByUserId(userId);
        const connectedProviders = providerAccounts
            .filter((account) => this.isConnectedProviderAccount(account))
            .map((account) => ({
                provider: account.providerId,
                createdAt: account.createdAt,
            }));

        return {
            ...userProfile,
            oauthTokens: connectedProviders,
        };
    }

    async updateUserProfile(userId: string, updateData: UpdateProfileDto) {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new BadRequestException('User not found');
        }

        const isNotNull = (value: any) => {
            return value !== null && value !== undefined;
        };

        // Update user profile
        const updateFields: Record<string, any> = {};
        if (isNotNull(updateData.username)) updateFields.username = updateData.username;
        if (isNotNull(updateData.avatar)) updateFields.avatar = updateData.avatar;
        // Allow explicitly setting committer fields to null (to clear them)
        if (updateData.committerName !== undefined)
            updateFields.committerName = updateData.committerName || null;
        if (updateData.committerEmail !== undefined) {
            // L-04: prevent intra-platform attribution spoofing. A user
            // can't claim another user's verified primary email as their
            // git-commit author. Self-email is fine (it's the default
            // already). Setting an unrelated email (e.g. work@somewhere) is
            // still allowed — git's author/committer fields are not
            // verified by git itself, only this cross-tenant guard.
            const claimedEmail = updateData.committerEmail?.toLowerCase().trim() ?? '';
            if (claimedEmail && claimedEmail !== (user.email ?? '').toLowerCase()) {
                const collision = await this.userRepository.findByEmail(claimedEmail);
                if (collision && collision.id !== userId) {
                    this.logger.warn(
                        `auth.profile.committerEmail.collision user=${userId} attemptedEmail=${claimedEmail} collisionUserId=${collision.id}`,
                    );
                    throw new BadRequestException(
                        'committerEmail conflicts with another user. Use your own email or leave blank to fall back to your account email.',
                    );
                }
            }
            updateFields.committerEmail = updateData.committerEmail || null;
        }
        if (typeof updateData.emailBudgetAlerts === 'boolean')
            updateFields.emailBudgetAlerts = updateData.emailBudgetAlerts;

        await this.userRepository.update(userId, updateFields);

        // Return updated profile
        return this.getUserProfile(userId);
    }

    async validateEmailVerificationToken(token: string) {
        // H-01: lookup by sha256(submitted). DB stores hashes only.
        const tokenHash = hashToken(token);
        const user = await this.userRepository.findOne({
            where: { emailVerificationToken: tokenHash },
        });

        if (!user) {
            return { valid: false, message: 'Invalid verification token' };
        }

        if (user.emailVerificationExpires && new Date() > user.emailVerificationExpires) {
            return { valid: false, message: 'Verification token expired' };
        }

        return {
            valid: true,
            message: 'Token is valid',
            email: user.email,
            expiresAt: user.emailVerificationExpires,
        };
    }

    async validatePasswordResetToken(token: string) {
        // H-01: lookup by sha256(submitted). DB stores hashes only.
        const tokenHash = hashToken(token);
        const user = await this.userRepository.findOne({
            where: { passwordResetToken: tokenHash },
        });

        if (!user) {
            return { valid: false, message: 'Invalid reset token' };
        }

        if (user.passwordResetExpires && new Date() > user.passwordResetExpires) {
            return { valid: false, message: 'Reset token expired' };
        }

        return {
            valid: true,
            message: 'Token is valid',
            email: user.email,
            expiresAt: user.passwordResetExpires,
        };
    }

    private isConnectedProviderAccount(account: {
        providerId: string;
        accessToken?: string | null;
        accessTokenExpiresAt?: Date | null;
        scope?: string | null;
    }): boolean {
        if (!account.accessToken || this.authAccountRepository.isAccessTokenExpired(account)) {
            return false;
        }

        if (account.providerId !== AuthProvider.GITHUB) {
            return true;
        }

        return this.authAccountRepository.hasRequiredScopes(account, ['repo']);
    }

    private async randomHashedPassword() {
        // L-07 + H-03: bcrypt cost must match the canonical cost used by the
        // user-exists branch (`getBcryptCost()`, default 12). The legacy
        // `authConstants.bcryptSaltRounds` defaulted to 10, which made the
        // no-user branch finish ~4x faster and partially undermined H-03
        // timing equalization on forgot-password. See bcrypt-cost.ts for the
        // BCRYPT_COST env override.
        const randomPassword = randomBytes(16).toString('hex');
        const hashedPassword = await bcrypt.hash(randomPassword, getBcryptCost());
        return hashedPassword;
    }

    private ensureUserIsActive(user: User) {
        // Check if user is active
        if (!user.isActive) {
            throw new UnauthorizedException('Account is suspended');
        }
    }
}
