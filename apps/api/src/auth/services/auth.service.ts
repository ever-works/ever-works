import {
    Injectable,
    ConflictException,
    UnauthorizedException,
    BadRequestException,
    Logger,
} from '@nestjs/common';
import { UserRepository, OAuthTokenRepository } from '@ever-works/agent/database';
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
        private readonly oauthTokenRepository: OAuthTokenRepository,
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
                    new UserConfirmedEvent(user, `${this.webAppUrl}/directories/new`),
                );
            }
        } else {
            this.ensureUserIsActive(user);

            const existingProviderLink = await this.oauthTokenRepository.findByUserAndProvider(
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

        await this.oauthTokenRepository.upsert({
            userId: user.id,
            username: socialUser.username || undefined,
            provider: socialUser.provider,
            accessToken: socialUser.accessToken,
            refreshToken: socialUser.refreshToken || null,
            tokenType: socialUser.tokenType || 'Bearer',
            expiresAt: socialUser.expiresAt || null,
            scope: socialUser.scope || null,
            metadata: socialUser.metadata || {},
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

        // Emit event to send verification email
        this.eventEmitter.emit(
            UserCreatedEvent.EVENT_NAME,
            new UserCreatedEvent(user, verificationToken, callbackUrl),
        );

        return {
            message: 'Verification email sent',
            // Remove this in production
            verificationToken,
            expiresAt: expires,
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
            new UserConfirmedEvent(updatedUser, `${this.webAppUrl}/directories/new`),
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

        // let callbackUrl = forgotPasswordDto.resetPasswordCallbackUrl;
        let callbackUrl = null;
        if (callbackUrl && !callbackUrl.includes('token=')) {
            callbackUrl += `?token=${resetToken}`;
        } else {
            callbackUrl = `${this.webAppUrl}/api/auth/reset-password?token=${resetToken}`;
        }

        // Emit event to send reset email
        this.eventEmitter.emit(
            UserForgotPasswordEvent.EVENT_NAME,
            new UserForgotPasswordEvent(user, resetToken, callbackUrl, '1 hour'),
        );

        return {
            message: 'If the email exists, a reset link has been sent',
            // Remove this in production
            resetToken,
            expiresAt: expires,
        };
    }

    async consumePasswordResetToken(token: string) {
        const user = await this.userRepository.findOne({
            where: { passwordResetToken: token },
        });

        if (!user) {
            throw new BadRequestException('Invalid reset token');
        }

        if (user.passwordResetExpires && new Date() > user.passwordResetExpires) {
            throw new BadRequestException('Reset token expired');
        }

        await this.userRepository.update(user.id, {
            passwordResetToken: null,
            passwordResetExpires: null,
        });

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

        // Get connected providers from OAuth tokens
        const oauthTokens = await this.oauthTokenRepository.findByUserId(userId);
        const connectedProviders = oauthTokens.map((token) => ({
            provider: token.provider,
            createdAt: token.createdAt,
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
