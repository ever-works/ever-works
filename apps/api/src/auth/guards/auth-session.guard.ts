import { Injectable, ExecutionContext, UnauthorizedException, Inject } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ApiKeyService } from '../services/api-key.service';
import { UserRepository } from '@ever-works/agent/database';
import type { AuthenticatedUser } from '../types/auth.types';
import { AUTH_PROVIDER } from '../providers/auth-provider.constants';
import { AuthProvider } from '../providers/auth-provider.abstract';
import { toHeaders } from '../providers/request-headers';

const API_KEY_PREFIX = 'ew_live_';

@Injectable()
export class AuthSessionGuard {
    private apiKeyService: ApiKeyService;
    private userRepository: UserRepository;

    constructor(
        private reflector: Reflector,
        private moduleRef: ModuleRef,
        @Inject(AUTH_PROVIDER)
        private readonly authProvider: AuthProvider,
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
        const apiKey = this.extractApiKey(request);

        if (apiKey) {
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

        const providerUser = await this.authProvider.authenticate(toHeaders(request.headers || {}));
        if (providerUser) {
            request.user = providerUser;
            return true;
        }

        throw new UnauthorizedException();
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
