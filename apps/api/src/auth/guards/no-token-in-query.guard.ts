import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { EVER_ID_QUERY_TOKEN_PARAMS } from '@ever-works/contracts';
import { EverIdHttpException } from '../services/ever-id-errors';

/** Route metadata: refuse a token in the query string before anything else runs (FR-17). */
export const NO_TOKEN_IN_QUERY = 'everIdNoTokenInQuery';

/** Every path under this prefix is checked whatever its metadata says (plan §5.1). */
export const EVER_ID_ROUTE_PREFIX = '/api/auth/ever-id/';

const FORBIDDEN_KEYS = new Set(EVER_ID_QUERY_TOKEN_PARAMS.map((key) => key.toLowerCase()));

/**
 * Whether `request` carries a token as a query parameter — the one predicate
 * `NoTokenInQueryGuard` and `AuthSessionGuard` share, so the two cannot drift
 * (APW-12 plan §5.1, FR-17, S19).
 *
 * Keys are compared case-insensitively against `EVER_ID_QUERY_TOKEN_PARAMS`
 * (`access_token`, `id_token`, `logout_token`, `token`, `sessionToken`,
 * `code_verifier`). Only the key is examined; the value is never read, logged
 * or echoed.
 */
export function hasTokenInQuery(request: { query?: unknown; url?: unknown }): boolean {
    const query = request?.query;
    if (query && typeof query === 'object') {
        for (const key of Object.keys(query as Record<string, unknown>)) {
            if (FORBIDDEN_KEYS.has(key.toLowerCase())) return true;
        }
        return false;
    }
    // No parsed query object (an adapter that does not populate it): read the
    // raw URL's search part instead.
    const url = typeof request?.url === 'string' ? request.url : '';
    const index = url.indexOf('?');
    if (index < 0) return false;
    for (const key of new URLSearchParams(url.slice(index + 1)).keys()) {
        if (FORBIDDEN_KEYS.has(key.toLowerCase())) return true;
    }
    return false;
}

/** Whether a request path is an Ever ID route (always checked, metadata or not). */
export function isEverIdPath(request: {
    path?: unknown;
    url?: unknown;
    originalUrl?: unknown;
}): boolean {
    const raw =
        (typeof request?.originalUrl === 'string' && request.originalUrl) ||
        (typeof request?.url === 'string' && request.url) ||
        (typeof request?.path === 'string' && request.path) ||
        '';
    const path = raw.split('?')[0];
    return path.startsWith(EVER_ID_ROUTE_PREFIX) || path === EVER_ID_ROUTE_PREFIX.slice(0, -1);
}

/**
 * APW-12 (Ever ID) — refuses a request that carries an access, ID, logout or
 * session token in its query string with `400 tokenInQuery` (FR-17, S19,
 * ACC-12-10).
 *
 * The same predicate runs first inside the global `AuthSessionGuard` for every
 * `/api/auth/ever-id/*` path and every handler carrying {@link NO_TOKEN_IN_QUERY}
 * metadata — that is what makes an UNAUTHENTICATED caller get the 400 rather
 * than a 401, since the global guard runs before any controller-level guard.
 * This guard is the controller-level belt for handlers that opt in.
 */
@Injectable()
export class NoTokenInQueryGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest();
        if (hasTokenInQuery(request)) {
            throw new EverIdHttpException('tokenInQuery');
        }
        return true;
    }
}
