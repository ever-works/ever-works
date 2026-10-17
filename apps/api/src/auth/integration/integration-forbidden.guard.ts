import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
    Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from '../types/auth.types';
import { SESSION_CREDENTIAL_ONLY_KEY } from './integration.decorators';
import { IntegrationHttpException } from './integration-http.exception';

/**
 * EW-P1-2 — `IntegrationForbiddenGuard`: the routes an integration key can
 * NEVER call, whatever scopes it holds (plan doc 02 §2 "session-only
 * actions"): key management, account, security, billing and Ever ID admin.
 *
 * Applied with `@UseGuards(IntegrationForbiddenGuard)` on those controllers.
 * It is defence in depth on top of `IntegrationPrincipalGuard`, which already
 * refuses an integration key on any route without `@RequireScopes(...)`: a
 * later `@RequireScopes` on one of these controllers by mistake still cannot
 * open it.
 *
 * Handlers marked `@SessionCredentialOnly()` (creating and rotating API keys)
 * additionally refuse EVERY machine credential — a personal `ew_live_` key, a
 * fleet-run token, a delegated Ever ID token, a request with no stamp — and
 * admit only `authMethod === 'session'`. That closes the existing hole where
 * a leaked `ew_live_` key could mint up to ten more keys.
 *
 * `@Public()` routes on the same controllers are unaffected: no principal,
 * nothing to refuse.
 */
@Injectable()
export class IntegrationForbiddenGuard implements CanActivate {
    private readonly logger = new Logger(IntegrationForbiddenGuard.name);

    constructor(private readonly reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        if (context.getType() !== 'http') return true;
        const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
        const user = request.user;
        if (!user) return true;

        if (user.authMethod === 'integration') {
            this.logger.warn(
                `Integration key ${user.integration?.keyId ?? '?'} refused on a session-only route.`,
            );
            throw new IntegrationHttpException(
                403,
                'scope_missing',
                'Integration keys cannot manage keys, accounts, security, billing or Ever ID.',
                { reason: 'integration_forbidden' },
            );
        }

        const sessionOnly = this.reflector.getAllAndOverride<boolean>(SESSION_CREDENTIAL_ONLY_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (sessionOnly && user.authMethod !== 'session') {
            throw new ForbiddenException(
                'Only a person signed in to Ever Works can create or rotate API keys. ' +
                    'An API key cannot be used to mint another key.',
            );
        }
        return true;
    }
}
