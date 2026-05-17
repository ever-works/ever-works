import {
    Injectable,
    ConflictException,
    UnauthorizedException,
    BadRequestException,
    Logger,
} from '@nestjs/common';
import { UserRepository, AuthAccountRepository } from '@ever-works/agent/database';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { authConstants, AuthProvider, config } from '../../config/constants';
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

    constructor(
        private readonly userRepository: UserRepository,
        private readonly authAccountRepository: AuthAccountRepository,
        private eventEmitter: EventEmitter2,
    ) {
        this.webAppUrl = config.webAppUrl();
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

        await this.userRepository.update(userId, {
            emailVerificationToken: verificationToken,
            emailVerificationExpires: expires,
        });

        if (callbackUrl && !callbackUrl.includes('token=')) {
            callbackUrl += `?token=${verificationToken}`;
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
            // Don't reveal if email exists
            return { message: 'If the email exists, a reset link has been sent' };
        }

        const resetToken = randomBytes(32).toString('hex');
        const expires = new Date();
        expires.setHours(expires.getHours() + 1); // 1 hour expiry

        await this.userRepository.update(user.id, {
            passwordResetToken: resetToken,
            passwordResetExpires: expires,
        });

        let callbackUrl = forgotPasswordDto.resetPasswordCallbackUrl || null;
        if (callbackUrl && !callbackUrl.includes('token=')) {
            callbackUrl += `?token=${resetToken}`;
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
        const user = await this.userRepository.findOne({
            where: { passwordResetToken: token },
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

        const consumed = await this.userRepository.clearPasswordResetToken(user.id, token);
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
        if (updateData.committerEmail !== undefined)
            updateFields.committerEmail = updateData.committerEmail || null;
        if (typeof updateData.emailBudgetAlerts === 'boolean')
            updateFields.emailBudgetAlerts = updateData.emailBudgetAlerts;

        await this.userRepository.update(userId, updateFields);

        // Return updated profile
        return this.getUserProfile(userId);
    }

    async validateEmailVerificationToken(token: string) {
        const user = await this.userRepository.findOne({
            where: { emailVerificationToken: token },
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
        const user = await this.userRepository.findOne({
            where: { passwordResetToken: token },
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
        const randomPassword = randomBytes(16).toString('hex');
        const hashedPassword = await bcrypt.hash(randomPassword, authConstants.bcryptSaltRounds);
        return hashedPassword;
    }

    private ensureUserIsActive(user: User) {
        // Check if user is active
        if (!user.isActive) {
            throw new UnauthorizedException('Account is suspended');
        }
    }
}
