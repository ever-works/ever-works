import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { UserRepository } from '@ever-works/agent/database';
import { AuthSession, User } from '@ever-works/agent/entities';
import type { AuthenticatedUser, TokenResponse } from '../types/auth.types';
import { AUTH_RUNTIME_INSTANCE } from './auth-provider.constants';
import { AuthProvider } from './auth-provider.abstract';
import { createAuthRuntimeInstance } from './auth-runtime.instance';
import type { AuthRuntimeContext, AuthRuntimeUser } from './auth-provider.types';
import { AuthSyncService } from './auth-sync.service';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

@Injectable()
export class AuthProviderService extends AuthProvider {
    constructor(
        @Inject(AUTH_RUNTIME_INSTANCE)
        private readonly auth: ReturnType<typeof createAuthRuntimeInstance>,
        private readonly userRepository: UserRepository,
        private readonly authSyncService: AuthSyncService,
        @InjectDataSource() private readonly dataSource: DataSource,
    ) {
        super();
    }

    async authenticate(headers: Headers): Promise<AuthenticatedUser | null> {
        const bearerToken = this.getBearerToken(headers);
        if (bearerToken) {
            const session = await this.findSessionRecord(bearerToken);
            if (!session) {
                return null;
            }

            if (session.expiresAt.getTime() <= Date.now()) {
                await this.deleteSessionRecord(bearerToken);
                return null;
            }

            const user = await this.assertActiveUser(session.userId);
            return this.mapAuthenticatedUserFromUser(user);
        }

        const session = await this.auth.api.getSession({ headers });
        if (!session) {
            return null;
        }

        if ((session.user as AuthRuntimeUser).isActive === false) {
            await this.signOutAll(session.user.id);
            throw new UnauthorizedException('User account is suspended');
        }

        return this.mapAuthenticatedUser(session.user as AuthRuntimeUser);
    }

    async signInEmail(email: string, password: string, headers: Headers): Promise<TokenResponse> {
        const existingUser = await this.userRepository.findByEmail(email);
        if (existingUser?.password) {
            await this.authSyncService.ensureCredentialAccount(
                existingUser.id,
                existingUser.password,
            );
        }

        const result = await this.auth.api.signInEmail({
            headers,
            body: {
                email,
                password,
                rememberMe: true,
            },
        });

        const user = await this.assertActiveUser(result.user.id);
        const passwordHash = await this.authSyncService.getCredentialPasswordHash(user.id);
        if (passwordHash) {
            await this.userRepository.update(user.id, {
                password: passwordHash,
                lastLoginAt: new Date(),
                registrationProvider: 'local',
            });
        }

        if (!result.token) {
            throw new UnauthorizedException('Failed to establish authenticated session');
        }

        return {
            access_token: result.token,
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
            },
        };
    }

    async signUpEmail(
        name: string,
        email: string,
        password: string,
        headers: Headers,
    ): Promise<TokenResponse> {
        const result = await this.auth.api.signUpEmail({
            headers,
            body: {
                name,
                email,
                password,
                rememberMe: true,
            },
        });

        const passwordHash = await this.authSyncService.getCredentialPasswordHash(result.user.id);
        if (passwordHash) {
            await this.userRepository.update(result.user.id, {
                password: passwordHash,
                registrationProvider: 'local',
                isActive: true,
            });
        }

        if (result.token) {
            const user = await this.assertActiveUser(result.user.id);
            return {
                access_token: result.token,
                user: {
                    id: user.id,
                    email: user.email,
                    username: user.username,
                },
            };
        }

        return this.issueSession(result.user.id);
    }

    async issueSession(
        userId: string,
        clientFingerprint?: { ipAddress?: string | null; userAgent?: string | null },
    ): Promise<TokenResponse> {
        const user = await this.assertActiveUser(userId);
        const session = await this.createSessionRecord(user.id, clientFingerprint);

        return {
            access_token: session.token,
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
            },
        };
    }

    async changePassword(
        currentPassword: string,
        newPassword: string,
        headers: Headers,
    ): Promise<void> {
        const user = await this.requireAuthenticatedUser(headers);
        const passwordHash = await this.authSyncService.getCredentialPasswordHash(user.id);
        if (!passwordHash) {
            throw new UnauthorizedException('Password login is not configured for this account');
        }

        const isMatch = await bcrypt.compare(currentPassword, passwordHash);
        if (!isMatch) {
            throw new UnauthorizedException('Current password is incorrect');
        }

        await this.setPassword(user.id, newPassword);
    }

    async setPassword(userId: string, newPassword: string): Promise<void> {
        const context = await this.getContext();
        const passwordHash = await context.password.hash(newPassword);
        await this.authSyncService.syncCredentialPassword(userId, passwordHash);
        await this.userRepository.update(userId, {
            password: passwordHash,
        });
    }

    async signOut(headers: Headers): Promise<void> {
        const bearerToken = this.getBearerToken(headers);
        if (bearerToken) {
            await this.deleteSessionRecord(bearerToken);
            return;
        }

        await this.auth.api.signOut({ headers });
    }

    async signOutAll(userId: string): Promise<void> {
        await this.getSessionRepository().delete({ userId });
    }

    private async getContext(): Promise<AuthRuntimeContext> {
        return (await this.auth.$context) as AuthRuntimeContext;
    }

    private async requireAuthenticatedUser(headers: Headers) {
        const bearerToken = this.getBearerToken(headers);
        if (bearerToken) {
            const session = await this.findSessionRecord(bearerToken);
            if (!session) {
                throw new UnauthorizedException('Invalid session');
            }

            if (session.expiresAt.getTime() <= Date.now()) {
                await this.deleteSessionRecord(bearerToken);
                throw new UnauthorizedException('Session expired');
            }

            return this.assertActiveUser(session.userId);
        }

        const session = await this.auth.api.getSession({ headers });
        if (!session) {
            throw new UnauthorizedException('Missing session token');
        }

        if ((session.user as AuthRuntimeUser).isActive === false) {
            await this.signOutAll(session.user.id);
            throw new UnauthorizedException('User account is suspended');
        }

        return this.assertActiveUser(session.user.id);
    }

    private async assertActiveUser(userId: string) {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new UnauthorizedException('User not found');
        }

        if (!user.isActive) {
            await this.signOutAll(user.id);
            throw new UnauthorizedException('User account is suspended');
        }

        return user;
    }

    private getBearerToken(headers: Headers): string | null {
        const authorization = headers.get('authorization');
        if (!authorization) {
            return null;
        }

        const [scheme, token] = authorization.split(' ');
        if (scheme?.toLowerCase() !== 'bearer' || !token) {
            return null;
        }

        return token.trim();
    }

    private mapAuthenticatedUser(user: AuthRuntimeUser): AuthenticatedUser {
        return {
            userId: user.id,
            email: user.email,
            username: user.name,
            provider: user.registrationProvider || 'local',
            emailVerified: user.emailVerified,
            isActive: user.isActive !== false,
            avatar: user.image || null,
            iat: Math.floor(Date.now() / 1000),
            iss: 'auth-runtime',
            aud: 'ever-works-users',
        };
    }

    private mapAuthenticatedUserFromUser(user: User): AuthenticatedUser {
        return {
            userId: user.id,
            email: user.email,
            username: user.username,
            provider: user.registrationProvider || 'local',
            emailVerified: user.emailVerified,
            isActive: user.isActive !== false,
            avatar: user.avatar || null,
            iat: Math.floor(Date.now() / 1000),
            iss: 'auth-runtime',
            aud: 'ever-works-users',
        };
    }

    private getSessionRepository() {
        return this.dataSource.getRepository(AuthSession);
    }

    private async findSessionRecord(token: string) {
        return this.getSessionRepository().findOne({
            where: { token },
        });
    }

    private async deleteSessionRecord(token: string) {
        await this.getSessionRepository().delete({ token });
    }

    // H-04: bind sessions to the requesting client at creation. Callers
    // forward whatever fingerprint they can pull from the inbound request
    // (typically req.ip + req.headers['user-agent']). The values are
    // recorded for forensics; enforcement on use is a separate roadmap item.
    private async createSessionRecord(
        userId: string,
        clientFingerprint?: { ipAddress?: string | null; userAgent?: string | null },
    ) {
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 7);

        const session = this.getSessionRepository().create({
            id: randomUUID(),
            userId,
            token: randomBytes(24).toString('base64url'),
            expiresAt,
            ipAddress: clientFingerprint?.ipAddress ?? null,
            userAgent: clientFingerprint?.userAgent ?? null,
        });

        return this.getSessionRepository().save(session);
    }
}
