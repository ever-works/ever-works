import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyService } from '../services/api-key.service';
import { UserRepository } from '@ever-works/agent/database';
import type { AuthenticatedUser } from '../types/jwt.types';

const API_KEY_PREFIX = 'ew_live_';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
    private apiKeyService: ApiKeyService;
    private userRepository: UserRepository;

    constructor(
        private reflector: Reflector,
        private moduleRef: ModuleRef,
    ) {
        super();
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic) {
            return true;
        }

        // Try API key authentication first
        const request = context.switchToHttp().getRequest();
        const apiKey = this.extractApiKey(request);

        if (apiKey) {
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

        // Fall through to Passport JWT
        const result = super.canActivate(context);
        if (result instanceof Promise) {
            return result as Promise<boolean>;
        }
        return result as boolean;
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
