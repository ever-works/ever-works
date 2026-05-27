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

/**
 * Per-request auth guard for the API. Wires two independent credential
 * paths to a single `request.user` and stays decoupled from the auth
 * library via {@link AuthProvider}.
 *
 * Precedence (important — order matters and is intentional):
 *   1. `@Public()` short-circuits to allow.
 *   2. **API key** (`x-api-key: ew_live_…` OR `Authorization: Bearer
 *      ew_live_…`) — if a value with the `ew_live_` prefix is present
 *      in either slot, this guard treats the request as an API-key
 *      request and **never falls through** to the provider path, even
 *      if the key is rejected. A bad API key returns 401 with
 *      "Invalid or expired API key" instead of trying cookies. This
 *      is deliberate: a client sending an API key is asking for the
 *      machine-credential code path and should get a deterministic
 *      error, not silent fallback to a different identity.
 *   3. **Provider session** — delegated to
 *      {@link AuthProvider.authenticate}. The provider returns `null`
 *      (NOT a throw) when no/invalid session is found so the guard
 *      reaches the final 401 rather than masking a misconfiguration.
 *
 * **Synthesised JWT-shaped claims for API keys.** API-key auth has no
 * real JWT, so this guard fabricates an `AuthenticatedUser` with
 * `iat = now()`, `iss = 'ever-works'`, `aud = 'ever-works'` so
 * downstream code (logging, observability, anything that reads
 * `request.user`) sees a consistent shape regardless of which path
 * authenticated. Treat `iat` on an API-key request as "guard
 * activation time", NOT as "user signed in at" — it advances on
 * every request.
 *
 * **Lazy DI of `ApiKeyService` + `UserRepository`** via `moduleRef`.
 * Both are resolved on the first API-key request rather than via
 * constructor injection. This avoids a circular-import bind at
 * module init (the auth module imports services that themselves
 * pull guards transitively). Switching to constructor injection
 * here is likely to reintroduce a circular dep — confirm with
 * `nest start` before changing.
 *
 * **API-key prefix is the discriminator.** Only `ew_live_…` is
 * treated as an API key; any other `Bearer …` token falls through
 * to the provider (most providers will then parse it as a JWT
 * session). New key formats MUST keep the prefix or extend the
 * matcher in {@link extractApiKey}.
 */
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
