import {
    Injectable,
    ConflictException,
    UnauthorizedException,
    BadRequestException,
    Logger,
} from '@nestjs/common';
import {
    UserRepository,
    RefreshTokenRepository,
    OAuthTokenRepository,
} from '@ever-works/agent/database';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { RegisterDto, UpdatePasswordDto } from '../dto/auth.dto';
import { randomBytes, randomUUID } from 'crypto';
import { jwtConstants, authConstants, AuthProvider, config } from '../../config/constants';
import { User } from '@ever-works/agent/entities';
import { JwtPayload, TokenResponse } from '../types/jwt.types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UserCreatedEvent, UserConfirmedEvent, UserForgotPasswordEvent } from '../../events';
import { ForgotPasswordDto } from '../dto/email-verification.dto';
import { GITHUB_SCOPES } from '../config/github-scopes.config';
import { UpdateProfileDto } from '../dto/update-profile.dto';

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    private webAppUrl: string;

    constructor(
        private readonly userRepository: UserRepository,
        private readonly refreshTokenRepository: RefreshTokenRepository,
        private readonly oauthTokenRepository: OAuthTokenRepository,
        private readonly jwtService: JwtService,
        private eventEmitter: EventEmitter2,
    ) {
        this.webAppUrl = config.webAppUrl();
    }

    async validateUser(email: string, password: string) {
        const user = await this.userRepository.findByEmail(email);
        if (!user) {
            return null;
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (isMatch) {
            // Check if user is active
            this.ensureUserIsActive(user);

            // Check if email is verified (optional - you can make this required)
            if (!user.emailVerified) {
                this.logger.warn(`User ${user.id} logged in with unverified email`);
                // You can throw here to require email verification:
                // throw new UnauthorizedException('Please verify your email before logging in');
            }

            const { password, ...result } = user;
            return result;
        }

        return null;
    }

    async register(registerDto: RegisterDto) {
        const { username, email, password, emailVerificationCallbackUrl } = registerDto;

        const existingUser = await this.userRepository.findByEmail(email);
        if (existingUser) {
            throw new ConflictException('User with this email already exists');
        }

        const hashedPassword = await bcrypt.hash(password, authConstants.bcryptSaltRounds);

        const user = await this.userRepository.create({
            username,
            email,
            password: hashedPassword,
            registrationProvider: AuthProvider.LOCAL,
            emailVerified: false,
            isActive: true,
        });

        this.sendVerificationEmail(user.id);

        const { password: _, ...userWithoutPassword } = user;
        return this.generateTokens(userWithoutPassword);
    }

    async login(user: any, userAgent?: string, ipAddress?: string) {
        // Update last login info
        user = await this.userRepository.update(user.id, {
            lastLoginAt: new Date(),
            lastLoginIp: ipAddress,
            registrationProvider: AuthProvider.LOCAL,
        });

        const { password, ...result } = user;
        return this.generateTokens(result, userAgent, ipAddress);
    }

    async refreshToken(refreshToken: string, userAgent?: string, ipAddress?: string) {
        const tokenData = await this.refreshTokenRepository.findByToken(refreshToken);

        if (!tokenData) {
            throw new UnauthorizedException('Invalid refresh token');
        }

        // Check if token is expired (skip if expiration is disabled)
        if (!jwtConstants.isTokenExpirationDisabled() && new Date() > tokenData.expiresAt) {
            await this.refreshTokenRepository.revokeToken(refreshToken, 'Token expired');
            throw new UnauthorizedException('Refresh token expired');
        }

        // Detect token reuse (refresh token rotation security)
        if (tokenData.revoked) {
            // This is a serious security issue - revoke all tokens in the family
            this.logger.warn(`Attempted reuse of revoked token for user ${tokenData.userId}`);
            await this.refreshTokenRepository.revokeTokenFamily(
                tokenData.family,
                'Token reuse detected',
            );
            throw new UnauthorizedException('Token reuse detected - all tokens revoked');
        }

        const user = await this.userRepository.findById(tokenData.userId);
        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        const { password, ...userWithoutPassword } = user;
        return this.generateTokens(userWithoutPassword, userAgent, ipAddress, refreshToken);
    }

    async updatePassword(userId: string, updatePasswordDto: UpdatePasswordDto) {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        const isMatch = await bcrypt.compare(updatePasswordDto.currentPassword, user.password);
        if (!isMatch) {
            throw new UnauthorizedException('Current password is incorrect');
        }

        const hashedPassword = await bcrypt.hash(
            updatePasswordDto.newPassword,
            authConstants.bcryptSaltRounds,
        );
        await this.userRepository.update(userId, { password: hashedPassword });

        return { message: 'Password updated successfully' };
    }

    async validateGithubUser(accessToken: string, refreshToken: string, profile: any) {
        const email = profile.emails?.[0]?.value;
        if (!email) {
            throw new BadRequestException('No email found in GitHub profile');
        }

        let user = await this.userRepository.findByEmail(email);

        if (!user) {
            const hashedPassword = await this.randomHashedPassword();

            user = await this.userRepository.create({
                username: profile.username || profile.displayName,
                email: email,
                password: hashedPassword,
                registrationProvider: AuthProvider.GITHUB,
                avatar: profile.photos?.[0]?.value,
                emailVerified: true, // GitHub emails are pre-verified
                isActive: true,
            });

            // Send welcome email for new GitHub users
            this.eventEmitter.emit(
                UserConfirmedEvent.EVENT_NAME,
                new UserConfirmedEvent(user, `${this.webAppUrl}/directories/new`),
            );
        } else {
            // Check if user is active
            this.ensureUserIsActive(user);

            // Update user info if exists
            user = await this.userRepository.update(user.id, {
                username: profile.username || profile.displayName,
                avatar: profile.photos?.[0]?.value || user.avatar,
                registrationProvider: AuthProvider.GITHUB,
                lastLoginAt: new Date(),
            });
        }

        // Store OAuth tokens separately
        await this.oauthTokenRepository.upsert({
            userId: user.id,
            username: profile.username,
            provider: AuthProvider.GITHUB,
            accessToken: accessToken,
            refreshToken: refreshToken,
            tokenType: 'Bearer',
            scope: profile._json?.scope || GITHUB_SCOPES.join(' '),
            metadata: {
                login: profile._json?.login || profile.username,
                nodeId: profile._json?.node_id,
                type: profile._json?.type,
            },
        });

        const { password, ...userWithoutPassword } = user;
        return userWithoutPassword;
    }

    async validateGoogleUser(accessToken: string, refreshToken: string, profile: any) {
        const email = profile.emails?.[0]?.value;
        if (!email) {
            throw new BadRequestException('No email found in Google profile');
        }

        let user = await this.userRepository.findByEmail(email);
        const displayName = profile.displayName || email.split('@')[0];

        if (!user) {
            const hashedPassword = await this.randomHashedPassword();

            user = await this.userRepository.create({
                username: displayName,
                email: email,
                password: hashedPassword,
                registrationProvider: AuthProvider.GOOGLE,
                avatar: profile.photos?.[0]?.value,
                emailVerified: true, // Google emails are pre-verified
                isActive: true,
            });

            // Send welcome email for new Google users
            this.eventEmitter.emit(
                UserConfirmedEvent.EVENT_NAME,
                new UserConfirmedEvent(user, `${this.webAppUrl}/directories/new`),
            );
        } else {
            // Check if user is active
            this.ensureUserIsActive(user);

            // Update user info if exists
            user = await this.userRepository.update(user.id, {
                username: displayName,
                registrationProvider: AuthProvider.GOOGLE,
                avatar: profile.photos?.[0]?.value || user.avatar,
                lastLoginAt: new Date(),
            });
        }

        // Store OAuth tokens separately
        await this.oauthTokenRepository.upsert({
            userId: user.id,
            provider: AuthProvider.GOOGLE,
            accessToken: accessToken,
            refreshToken: refreshToken,
            tokenType: 'Bearer',
            expiresAt: profile._json?.expires_at ? new Date(profile._json.expires_at * 1000) : null,
            scope: profile._json?.scope || 'email profile',
            metadata: {
                sub: profile.id,
                emailVerified: profile._json?.email_verified,
            },
        });

        const { password, ...userWithoutPassword } = user;
        return userWithoutPassword;
    }

    async logout(refreshToken: string) {
        try {
            await this.refreshTokenRepository.revokeToken(refreshToken, 'User logout');
        } catch (error) {
            // Token might not exist, but we still want to return success
            this.logger.debug('Token not found during logout');
        }
        return { message: 'Logged out successfully' };
    }

    async logoutAllDevices(userId: string) {
        await this.refreshTokenRepository.revokeAllUserTokens(
            userId,
            'User logged out from all devices',
        );
        return { message: 'Logged out from all devices successfully' };
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

        const { password, ...userWithoutPassword } = updatedUser;

        // Generate new tokens with emailVerified: true in JWT payload
        return this.generateTokens(userWithoutPassword);
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

    async resetPassword(token: string, newPassword: string) {
        const user = await this.userRepository.findOne({
            where: { passwordResetToken: token },
        });

        if (!user) {
            throw new BadRequestException('Invalid reset token');
        }

        if (user.passwordResetExpires && new Date() > user.passwordResetExpires) {
            throw new BadRequestException('Reset token expired');
        }

        const hashedPassword = await bcrypt.hash(newPassword, authConstants.bcryptSaltRounds);

        await this.userRepository.update(user.id, {
            password: hashedPassword,
            passwordResetToken: null,
            passwordResetExpires: null,
        });

        // Revoke all refresh tokens for security
        await this.refreshTokenRepository.revokeAllUserTokens(user.id, 'Password reset');

        return { message: 'Password reset successfully' };
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

    private async generateTokens(
        user: Omit<User, 'password' | 'getGitToken' | 'asCommitter'>,
        userAgent?: string,
        ipAddress?: string,
        oldRefreshToken?: string,
    ): Promise<TokenResponse> {
        const payload: JwtPayload = {
            sub: user.id,
            email: user.email,
            provider: user.registrationProvider,
            username: user.username,
            emailVerified: user.emailVerified,
            isActive: user.isActive,
            avatar: user.avatar,
            iat: Math.floor(Date.now() / 1000),
            iss: 'ever-works-api',
            aud: 'ever-works-users',
        };

        const accessToken = this.jwtService.sign(payload, {
            expiresIn: jwtConstants.accessTokenExpiration(),
            secret: jwtConstants.secret(),
        });
        const refreshToken = await this.generateRefreshToken(
            user.id,
            userAgent,
            ipAddress,
            oldRefreshToken,
        );

        return {
            access_token: accessToken,
            refresh_token: refreshToken,
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
            },
        };
    }

    private async generateRefreshToken(
        userId: string,
        userAgent?: string,
        ipAddress?: string,
        oldRefreshToken?: string,
    ): Promise<string> {
        const token = randomBytes(authConstants.refreshTokenLength).toString('hex');

        let expiresAt: Date;
        const refreshDays = jwtConstants.refreshTokenExpiration();

        if (refreshDays === -1 || jwtConstants.isTokenExpirationDisabled()) {
            // Set expiration to 100 years in the future (effectively never)
            expiresAt = new Date();
            expiresAt.setFullYear(expiresAt.getFullYear() + 100);
        } else {
            expiresAt = new Date();
            expiresAt.setDate(expiresAt.getDate() + refreshDays);
        }

        let family: string = randomUUID();

        // If rotating from an old token, use the same family
        if (oldRefreshToken) {
            const oldToken = await this.refreshTokenRepository.findByToken(oldRefreshToken);
            if (oldToken) {
                family = oldToken.family || family;
                // Revoke the old token
                await this.refreshTokenRepository.revokeToken(oldRefreshToken, 'Token rotation');
            }
        }

        await this.refreshTokenRepository.create({
            token,
            userId,
            expiresAt,
            family,
            userAgent,
            ipAddress,
        });

        return token;
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
