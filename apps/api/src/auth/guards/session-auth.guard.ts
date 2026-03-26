import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyService } from '../services/api-key.service';
import { BetterAuthService } from '../services/better-auth.service';
import { UserRepository } from '@ever-works/agent/database';
import type { AuthenticatedUser } from '../types/jwt.types';

const API_KEY_PREFIX = 'ew_live_';

@Injectable()
export class SessionAuthGuard implements CanActivate {
    private apiKeyService: ApiKeyService;
    private userRepository: UserRepository;

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
        return this.authenticateWithSession(request);
    }

    private async authenticateWithApiKey(request: any, apiKey: string): Promise<boolean> {
        // Lazily resolve dependencies on first API key request
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

        const authenticatedUser: AuthenticatedUser = {
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

        request.user = authenticatedUser;
        return true;
    }

    private async authenticateWithSession(request: any): Promise<boolean> {
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
                throw new UnauthorizedException('Invalid or expired session');
            }

            // Look up the application user from the users table
            const user = await this.userRepository.findById(session.user.id);
            if (!user || !user.isActive) {
                throw new UnauthorizedException('User account is inactive');
            }

            // Construct the same AuthenticatedUser shape as the JWT guard
            const authenticatedUser: AuthenticatedUser = {
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

            request.user = authenticatedUser;
            return true;
        } catch (error) {
            if (error instanceof UnauthorizedException) {
                throw error;
            }
            throw new UnauthorizedException('Authentication required');
        }
    }

    private extractApiKey(request: any): string | null {
        // Check x-api-key header
        const headerKey = request.headers?.['x-api-key'];
        if (headerKey && typeof headerKey === 'string' && headerKey.startsWith(API_KEY_PREFIX)) {
            return headerKey;
        }

        // Check Authorization: Bearer ew_live_...
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
