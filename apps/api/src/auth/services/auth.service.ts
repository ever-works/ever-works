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
} from '@packages/agent/database';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { RegisterDto, UpdatePasswordDto } from '../dto/auth.dto';
import { randomBytes, randomUUID } from 'crypto';
import { jwtConstants, authConstants, AuthProviders } from '@src/config/constants';
import { User } from '@packages/agent/entities';
import { JwtPayload, TokenResponse } from '../types/jwt.types';

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    constructor(
        private readonly userRepository: UserRepository,
        private readonly refreshTokenRepository: RefreshTokenRepository,
        private readonly oauthTokenRepository: OAuthTokenRepository,
        private readonly jwtService: JwtService,
    ) {}

    async validateUser(email: string, password: string) {
        const user = await this.userRepository.findByEmail(email);
        if (!user) {
            return null;
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (isMatch) {
            // Check if user is active
            if (!user.isActive) {
                throw new UnauthorizedException('Account is suspended');
            }

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
        const { username, email, password } = registerDto;

        const existingUser = await this.userRepository.findByEmail(email);
        if (existingUser) {
            throw new ConflictException('User with this email already exists');
        }

        const existingUsername = await this.userRepository.findByUsername(username);
        if (existingUsername) {
            throw new ConflictException('Username already taken');
        }

        const hashedPassword = await bcrypt.hash(password, authConstants.bcryptSaltRounds);

        const user = await this.userRepository.create({
            username,
            email,
            password: hashedPassword,
            registrationProvider: AuthProviders.LOCAL,
            emailVerified: false,
            isActive: true,
        });

        const { password: _, ...userWithoutPassword } = user;
        return this.generateTokens(userWithoutPassword);
    }

    async login(user: any, userAgent?: string, ipAddress?: string) {
        // Update last login info
        await this.userRepository.update(user.id, {
            lastLoginAt: new Date(),
            lastLoginIp: ipAddress,
        });

        return this.generateTokens(user, userAgent, ipAddress);
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

    async validateGithubUser(profile: any) {
        const email = profile.emails?.[0]?.value;
        if (!email) {
            throw new BadRequestException('No email found in GitHub profile');
        }

        let user = await this.userRepository.findByEmail(email);

        if (!user) {
            const randomPassword = randomBytes(16).toString('hex');
            const hashedPassword = await bcrypt.hash(
                randomPassword,
                authConstants.bcryptSaltRounds,
            );

            user = await this.userRepository.create({
                username: profile.username || profile.displayName,
                email: email,
                password: hashedPassword,
                registrationProvider: AuthProviders.GITHUB,
                avatar: profile.photos?.[0]?.value,
                emailVerified: true, // GitHub emails are pre-verified
                isActive: true,
            });
        } else {
            // Update user info if exists
            await this.userRepository.update(user.id, {
                avatar: profile.photos?.[0]?.value || user.avatar,
                lastLoginAt: new Date(),
            });
        }

        // Store OAuth tokens separately
        await this.oauthTokenRepository.upsert({
            userId: user.id,
            provider: AuthProviders.GITHUB,
            accessToken: profile.accessToken,
            refreshToken: profile.refreshToken,
            tokenType: 'Bearer',
            scope: profile._json?.scope || 'user:email',
            metadata: {
                login: profile.username,
                nodeId: profile._json?.node_id,
                type: profile._json?.type,
            },
        });

        const { password, ...userWithoutPassword } = user;
        return userWithoutPassword;
    }

    async validateGoogleUser(profile: any) {
        const email = profile.emails?.[0]?.value;
        if (!email) {
            throw new BadRequestException('No email found in Google profile');
        }

        let user = await this.userRepository.findByEmail(email);

        if (!user) {
            const randomPassword = randomBytes(16).toString('hex');
            const hashedPassword = await bcrypt.hash(
                randomPassword,
                authConstants.bcryptSaltRounds,
            );

            user = await this.userRepository.create({
                username: profile.displayName || email.split('@')[0],
                email: email,
                password: hashedPassword,
                registrationProvider: AuthProviders.GOOGLE,
                avatar: profile.photos?.[0]?.value,
                emailVerified: true, // Google emails are pre-verified
                isActive: true,
            });
        } else {
            // Update user info if exists
            await this.userRepository.update(user.id, {
                avatar: profile.photos?.[0]?.value || user.avatar,
                lastLoginAt: new Date(),
            });
        }

        // Store OAuth tokens separately
        await this.oauthTokenRepository.upsert({
            userId: user.id,
            provider: AuthProviders.GOOGLE,
            accessToken: profile.accessToken,
            refreshToken: profile.refreshToken,
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

    async sendVerificationEmail(userId: string) {
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

        // TODO: Send email with verification link
        // For now, return the token (in production, this would be sent via email)
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

        return { message: 'Email verified successfully' };
    }

    async forgotPassword(email: string) {
        const user = await this.userRepository.findByEmail(email);
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

        // TODO: Send email with reset link
        // For now, return the token (in production, this would be sent via email)
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
            oauthTokens,
            ...userProfile
        } = user;

        // Add connected providers info
        const connectedProviders =
            oauthTokens?.map((token) => ({
                provider: token.provider,
                createdAt: token.createdAt,
            })) || [];

        return {
            ...userProfile,
            oauthTokens: connectedProviders,
        };
    }

    async updateUserProfile(userId: string, updateData: { username?: string; avatar?: string }) {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new BadRequestException('User not found');
        }

        // Check if username is being changed and if it's already taken
        if (updateData.username && updateData.username !== user.username) {
            const existingUser = await this.userRepository.findByUsername(updateData.username);
            if (existingUser) {
                throw new ConflictException('Username already taken');
            }
        }

        // Update user profile
        await this.userRepository.update(userId, {
            ...(updateData.username && { username: updateData.username }),
            ...(updateData.avatar && { avatar: updateData.avatar }),
        });

        // Return updated profile
        return this.getUserProfile(userId);
    }
}
