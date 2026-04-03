import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyService } from '../services/api-key.service';
import { AuthProviderService } from '../services/auth-provider.service';
import { UserRepository } from '@ever-works/agent/database';
import type { AuthenticatedUser } from '../types/auth-user.types';

const API_KEY_PREFIX = 'ew_live_';

@Injectable()
export class SessionAuthGuard implements CanActivate {
    private apiKeyService: ApiKeyService;
    private userRepository: UserRepository;

    constructor(
        private reflector: Reflector,
        private moduleRef: ModuleRef,
        private authProviderService: AuthProviderService,
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

        // 1. Try API key authentication first
        const apiKey = this.extractApiKey(request);
        if (apiKey) {
            return this.authenticateWithApiKey(request, apiKey);
        }

        // 2. Try session authentication via the configured auth provider
        const sessionResult = await this.tryAuthenticateWithSession(request);
        if (sessionResult) {
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

        // Convert Express request headers to standard Headers for the auth provider
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
            if (value) {
                headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
            }
        }

        try {
            const session = await this.authProviderService.api.getSession({ headers });

            if (!session || !session.user) {
                return false;
            }

            // Find application user by provider ID, or fall back to email
            // (IDs may differ for users who existed before the auth provider migration)
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
