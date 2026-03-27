import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyService } from '../services/api-key.service';
import { BetterAuthService } from '../services/better-auth.service';
import { UserRepository } from '@ever-works/agent/database';
import { JwtService } from '@nestjs/jwt';
import { jwtConstants } from '../../config/constants';
import type { AuthenticatedUser, JwtPayload } from '../types/jwt.types';

const API_KEY_PREFIX = 'ew_live_';

@Injectable()
export class SessionAuthGuard implements CanActivate {
    private apiKeyService: ApiKeyService;
    private userRepository: UserRepository;
    private jwtService: JwtService;

    constructor(
        private reflector: Reflector,
        private moduleRef: ModuleRef,
        private betterAuthService: BetterAuthService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic) {
            return true;
        }

        const request = context.switchToHttp().getRequest();

        // 1. Try API key authentication first (preserved from JwtAuthGuard)
        const apiKey = this.extractApiKey(request);
        if (apiKey) {
            return this.authenticateWithApiKey(request, apiKey);
        }

        // 2. Try BetterAuth session authentication
        const sessionResult = await this.tryAuthenticateWithSession(request);
        if (sessionResult) {
            return true;
        }

        // 3. Fall back to legacy JWT authentication (for existing sessions during transition)
        const jwtResult = await this.tryAuthenticateWithJwt(request);
        if (jwtResult) {
            return true;
        }

        throw new UnauthorizedException('Authentication required');
    }

    private async authenticateWithApiKey(request: any, apiKey: string): Promise<boolean> {
        if (!this.apiKeyService) {
            this.apiKeyService = this.moduleRef.get(ApiKeyService, { strict: false });
        }
        if (!this.userRepository) {
            this.userRepository = this.moduleRef.get(UserRepository, { strict: false });
        }

        const keyRecord = await this.apiKeyService.validateKey(apiKey);
        if (!keyRecord) {
            throw new UnauthorizedException('Invalid or expired API key');
        }

        const user = await this.userRepository.findById(keyRecord.userId);
        if (!user || !user.isActive) {
            throw new UnauthorizedException('User account is inactive');
        }

        request.user = this.buildAuthenticatedUser(user);
        return true;
    }

    private async tryAuthenticateWithSession(request: any): Promise<boolean> {
        if (!this.userRepository) {
            this.userRepository = this.moduleRef.get(UserRepository, { strict: false });
        }

        // Convert Express request headers to standard Headers for BetterAuth
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
            if (value) {
                headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
            }
        }

        try {
            const session = await this.betterAuthService.api.getSession({ headers });

            if (!session || !session.user) {
                return false;
            }

            // Find application user by BetterAuth ID, or fall back to email
            // (IDs may differ for users who existed before BetterAuth migration)
            let user = await this.userRepository.findById(session.user.id);
            if (!user && session.user.email) {
                user = await this.userRepository.findByEmail(session.user.email);
            }
            if (!user || !user.isActive) {
                return false;
            }

            request.user = this.buildAuthenticatedUser(user);
            return true;
        } catch {
            return false;
        }
    }

    private async tryAuthenticateWithJwt(request: any): Promise<boolean> {
        if (!this.jwtService) {
            this.jwtService = this.moduleRef.get(JwtService, { strict: false });
        }

        const authHeader = request.headers?.authorization;
        if (!authHeader || typeof authHeader !== 'string') {
            return false;
        }

        const [scheme, token] = authHeader.split(' ');
        if (scheme !== 'Bearer' || !token || token.startsWith(API_KEY_PREFIX)) {
            return false;
        }

        try {
            const payload = this.jwtService.verify<JwtPayload>(token, {
                secret: jwtConstants.secret(),
            });

            if (!payload?.sub) {
                return false;
            }

            const authenticatedUser: AuthenticatedUser = {
                userId: payload.sub,
                email: payload.email,
                username: payload.username,
                provider: payload.provider,
                emailVerified: payload.emailVerified,
                isActive: payload.isActive,
                avatar: payload.avatar,
                iat: payload.iat,
                iss: payload.iss,
                aud: payload.aud,
            };

            request.user = authenticatedUser;
            return true;
        } catch {
            return false;
        }
    }

    private buildAuthenticatedUser(user: any): AuthenticatedUser {
        return {
            userId: user.id,
            email: user.email,
            username: user.username,
            provider: user.registrationProvider,
            emailVerified: user.emailVerified,
            isActive: user.isActive,
            avatar: user.avatar || null,
            iat: Math.floor(Date.now() / 1000),
            iss: 'ever-works',
            aud: 'ever-works',
        };
    }

    private extractApiKey(request: any): string | null {
        const headerKey = request.headers?.['x-api-key'];
        if (headerKey && typeof headerKey === 'string' && headerKey.startsWith(API_KEY_PREFIX)) {
            return headerKey;
        }

        const authHeader = request.headers?.authorization;
        if (authHeader && typeof authHeader === 'string') {
            const [scheme, token] = authHeader.split(' ');
            if (scheme === 'Bearer' && token?.startsWith(API_KEY_PREFIX)) {
                return token;
            }
        }

        return null;
    }
}
