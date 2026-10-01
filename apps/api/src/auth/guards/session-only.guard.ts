import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../types/auth.types';
import { EverIdHttpException } from '../services/ever-id-errors';

/**
 * APW-12 (Ever ID) — admits only a signed-in person's interactive session
 * (spec S27, FR-25, ACC-12-21).
 *
 * Runs after the global `AuthSessionGuard`, which stamps `authMethod` on every
 * request it authenticates. Anything that is not `'session'` — a personal API
 * key or a fleet-run token (`'api-key'`), a delegated Ever ID token
 * (`'ever-id-delegated'`), or a request with no stamp at all — is refused with
 * `403 sessionRequired`. Same predicate and fail-closed reading as AW-24's
 * `HumanActorGuard`, which stays separate because its copy and refusal record
 * are specific to the safety rails.
 */
@Injectable()
export class SessionOnlyGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
        if (request.user?.authMethod !== 'session') {
            throw new EverIdHttpException('sessionRequired');
        }
        return true;
    }
}
