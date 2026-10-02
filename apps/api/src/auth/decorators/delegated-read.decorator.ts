import { SetMetadata, UseGuards, applyDecorators } from '@nestjs/common';
import type { EverIdDelegatedScope } from '@ever-works/contracts';
import { NO_TOKEN_IN_QUERY, NoTokenInQueryGuard } from '../guards/no-token-in-query.guard';

/** Route metadata naming the delegated scope a handler admits (APW-12 plan §5.3). */
export const DELEGATED_READ_SCOPE = 'everIdDelegatedReadScope';

/**
 * Route metadata holding the function that answers which browser origins a
 * delegated token is accepted from on the handler (APW-11 FR-50). Absent means
 * the handler sets no origin rule.
 */
export const DELEGATED_READ_ORIGINS = 'everIdDelegatedReadOrigins';

/** Reads the allowed origins. Called once per delegated request; it should return the same list each time. */
export type DelegatedReadOriginsResolver = () => readonly string[];

export interface DelegatedReadOptions {
    /**
     * The exact browser origins (`https://host[:port]`) a delegated token is
     * accepted from on this handler. When given, a request carrying a delegated
     * token whose `Origin` header is absent or not in the list is refused with
     * `403 origin_not_allowed` **before the token is read**: no verification, no
     * provider key fetch and no record of the read (APW-11 FR-50, ACC-11-38).
     * A session or API-key caller is never affected.
     */
    allowedOrigins?: DelegatedReadOriginsResolver;
}

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
 *
 * `options.allowedOrigins` (added for APW-11 FR-50) narrows where such a token
 * may come from; without it the handler behaves exactly as before.
 */
export function DelegatedRead(scope: EverIdDelegatedScope, options: DelegatedReadOptions = {}) {
    const decorators = [
        SetMetadata(DELEGATED_READ_SCOPE, scope),
        SetMetadata(NO_TOKEN_IN_QUERY, true),
        UseGuards(NoTokenInQueryGuard),
    ];
    if (options.allowedOrigins) {
        decorators.push(SetMetadata(DELEGATED_READ_ORIGINS, options.allowedOrigins));
    }
    return applyDecorators(...decorators);
}
