import {
    Injectable,
    ConflictException,
    UnauthorizedException,
    BadRequestException,
} from '@nestjs/common';
import { UserRepository } from '@packages/agent/database';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { RegisterDto, UpdatePasswordDto } from './dto/auth.dto';
import { User } from '@packages/agent/entities';
import { randomBytes } from 'crypto';

const saltOrRounds = 10;

@Injectable()
export class AuthService {
    private refreshTokens = new Map<string, { userId: string; expiresAt: Date }>();

    constructor(
        private readonly userRepository: UserRepository,
        private readonly jwtService: JwtService,
    ) {}

    async validateUser(email: string, password: string) {
        const user = await this.userRepository.findByEmail(email);
        if (!user) {
            return null;
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (isMatch) {
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

        const hashedPassword = await bcrypt.hash(password, saltOrRounds);

        const user = await this.userRepository.create({
            username,
            email,
            password: hashedPassword,
        });

        const { password: _, ...userWithoutPassword } = user;
        return this.generateTokens(userWithoutPassword);
    }

    async login(user: any) {
        return this.generateTokens(user);
    }

    private generateTokens(user: any) {
        const payload = { email: user.email, sub: user.id };
        const accessToken = this.jwtService.sign(payload, {
            expiresIn: '15m',
            secret: process.env.JWT_SECRET || 'secret_key_here',
        });

        const refreshToken = this.generateRefreshToken(user.id);

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

    private generateRefreshToken(userId: string): string {
        const token = randomBytes(32).toString('hex');
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiry

        this.refreshTokens.set(token, { userId, expiresAt });
        return token;
    }

    async refreshToken(refreshToken: string) {
        const tokenData = this.refreshTokens.get(refreshToken);

        if (!tokenData) {
            throw new UnauthorizedException('Invalid refresh token');
        }

        if (new Date() > tokenData.expiresAt) {
            this.refreshTokens.delete(refreshToken);
            throw new UnauthorizedException('Refresh token expired');
        }

        const user = await this.userRepository.findById(tokenData.userId);
        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        this.refreshTokens.delete(refreshToken);
        const { password, ...userWithoutPassword } = user;
        return this.generateTokens(userWithoutPassword);
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

        const hashedPassword = await bcrypt.hash(updatePasswordDto.newPassword, saltOrRounds);
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
            const hashedPassword = await bcrypt.hash(randomPassword, saltOrRounds);

            user = await this.userRepository.create({
                username: profile.username || profile.displayName,
                email: email,
                password: hashedPassword,
                githubToken: profile.accessToken,
                githubId: profile.id,
                provider: 'github',
                avatar: profile.photos?.[0]?.value,
            });
        } else {
            // Update GitHub token if user exists
            await this.userRepository.update(user.id, {
                githubToken: profile.accessToken,
                githubId: profile.id,
                avatar: profile.photos?.[0]?.value || user.avatar,
            });
        }

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
            const hashedPassword = await bcrypt.hash(randomPassword, saltOrRounds);

            user = await this.userRepository.create({
                username: profile.displayName || email.split('@')[0],
                email: email,
                password: hashedPassword,
                googleId: profile.id,
                provider: 'google',
                avatar: profile.photos?.[0]?.value,
            });
        } else {
            // Update Google ID if user exists
            await this.userRepository.update(user.id, {
                googleId: profile.id,
                avatar: profile.photos?.[0]?.value || user.avatar,
            });
        }

        const { password, ...userWithoutPassword } = user;
        return userWithoutPassword;
    }

    async logout(refreshToken: string) {
        this.refreshTokens.delete(refreshToken);
        return { message: 'Logged out successfully' };
    }
}
