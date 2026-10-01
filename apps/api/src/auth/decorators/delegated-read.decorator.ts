import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import type { EverIdDelegatedScope } from '@ever-works/contracts';
import { NO_TOKEN_IN_QUERY, NoTokenInQueryGuard } from '../guards/no-token-in-query.guard';

/** Route metadata naming the delegated scope a handler admits (APW-12 plan §5.3). */
export const DELEGATED_READ_SCOPE = 'everIdDelegatedReadScope';

/**
 * APW-12 (Ever ID) — mark a handler as readable by another app acting for the
 * person with a short-lived Ever ID access token carrying `scope` (FR-44..FR-47,
 * APW-11's App Launcher read).
 *
 * Only handlers carrying this decorator admit such a token: everywhere else the
 * token is answered exactly like an invalid credential (401, FR-46). On a marked
 * handler a token without the scope is answered `403 insufficientScope`. The
 * decorator also refuses a token in the query string (FR-17) through
 * {@link NoTokenInQueryGuard}.
 */
export function DelegatedRead(scope: EverIdDelegatedScope) {
    return applyDecorators(
        SetMetadata(DELEGATED_READ_SCOPE, scope),
        SetMetadata(NO_TOKEN_IN_QUERY, true),
        UseGuards(NoTokenInQueryGuard),
    );
}
