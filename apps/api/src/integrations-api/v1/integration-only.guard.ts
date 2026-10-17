import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { IntegrationHttpException } from '../../auth/integration/integration-http.exception';

/**
 * Integration API v1 (`/api/integrations/v1/*`) accepts ONLY the integration
 * principal — an `ew_int_…` key today, an Ever ID token later (plan doc 03
 * Part B). Sessions and personal keys get `401 invalid_key` in the
 * integration envelope: this namespace is a stable machine contract, not a
 * second user API.
 */
@Injectable()
export class IntegrationOnlyGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        if (context.getType() !== 'http') return true;
        const user = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>().user;
        if (user?.authMethod === 'integration' && user.integration) return true;
        throw new IntegrationHttpException(
            401,
            'invalid_key',
            'The integration API accepts integration keys (ew_int_…) only.',
        );
    }
}
