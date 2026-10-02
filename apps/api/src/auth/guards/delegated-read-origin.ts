import { HttpException, HttpStatus } from '@nestjs/common';
import {
    APP_LAUNCHER_ORIGIN_NOT_ALLOWED,
    type AppLauncherOriginNotAllowedErrorBody,
} from '@ever-works/contracts';
import type { DelegatedReadOriginsResolver } from '../decorators/delegated-read.decorator';

/**
 * APW-11 FR-50 / ACC-11-38 — where a delegated read may come from.
 *
 * A handler marked `@DelegatedRead(scope, { allowedOrigins })` accepts a
 * delegated Ever ID token only from a browser page on one of those exact
 * origins. `AuthSessionGuard` applies the rule in its delegated branch, before
 * the token is verified, so a refused request costs no signature check, no
 * provider key fetch and writes no record of a read.
 *
 * What it is and what it is not: an `Origin` header is set by the browser and
 * cannot be chosen by the page, so the rule keeps a delegated token from being
 * spent by a page the operator did not list. A non-browser client can send any
 * header it likes; for it the token itself (signature, audience, scope,
 * lifetime and, when configured, the trusted client ids) is the boundary. That
 * is why a request without an `Origin` is refused too (APW-11 plan §4.7: there is
 * no server-to-server delegated read yet), rather than treated as same-origin.
 */

const MESSAGE = 'Delegated reads are not accepted from this origin.';

/** The `403 origin_not_allowed` refusal, in the platform's `{ status, code, message }` shape. */
export class DelegatedReadOriginRefusedException extends HttpException {
    constructor() {
        const body: AppLauncherOriginNotAllowedErrorBody = {
            status: 'error',
            code: APP_LAUNCHER_ORIGIN_NOT_ALLOWED,
            message: MESSAGE,
        };
        super(body, HttpStatus.FORBIDDEN);
        this.name = 'DelegatedReadOriginRefusedException';
    }
}

/** The request's `Origin` header when it is a single non-empty string, else `null`. */
export function requestOrigin(request: {
    headers?: Record<string, unknown>;
}): string | null {
    const value = request.headers?.origin;
    return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Whether `origin` is on the list the handler declared.
 *
 * Exact comparison, like `LauncherDelegatedCorsMiddleware`'s: a browser sends
 * the serialized origin (lower-case scheme and host, no default port, no
 * trailing slash), so the two checks agree on every request and a near-miss
 * (`https://app.example.com.attacker.test`, `http://…`, `null`) is refused.
 * Any failure to read the list refuses: the rule fails closed.
 */
export function isDelegatedOriginAllowed(
    origin: string | null,
    resolveAllowed: DelegatedReadOriginsResolver,
): boolean {
    if (!origin) return false;
    let allowed: readonly string[];
    try {
        allowed = resolveAllowed();
    } catch {
        return false;
    }
    return Array.isArray(allowed) && allowed.includes(origin);
}
