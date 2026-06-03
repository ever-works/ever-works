import {
    CanActivate,
    ExecutionContext,
    Injectable,
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

interface RequestLike {
    headers: Record<string, string | string[] | undefined>;
}

/**
 * Authenticates every request to the internal-cli `serve` API with a random
 * per-start token.
 *
 * Background: `WorksController` mounts full work CRUD + AI generation and runs
 * every handler as the local user with NO authentication. Even bound to
 * loopback, any other local process (or a drive-by web page hitting the
 * localhost port) could drive the API. This guard closes that hole by
 * requiring a shared secret that only the operator who started the server
 * (and can read the 0600 token file) knows.
 *
 * The token is generated fresh at server start by `ServeCommand`, written to
 * `~/.ever-works/serve-token` with 0600 perms, and injected here. Callers must
 * present it via `Authorization: Bearer <token>` or `X-EW-CLI-Token: <token>`.
 *
 * Comparison is constant-time (`timingSafeEqual`) so the token can't be
 * recovered via a timing side-channel — mirrors `PlatformSecretGuard` and the
 * MCP `ApiKeyGuard`.
 */
@Injectable()
export class CliTokenGuard implements CanActivate {
    private readonly logger = new Logger(CliTokenGuard.name);

    constructor(private readonly token: string) {}

    canActivate(context: ExecutionContext): boolean {
        if (!this.token) {
            // Fail closed: a guard constructed without a token must never
            // accept a request. This should be impossible (ServeCommand always
            // generates one), but a misconfiguration must not silently expose
            // the unauthenticated API.
            this.logger.error('CLI serve token is not configured; rejecting request');
            throw new UnauthorizedException('Server auth is not configured');
        }

        const req = context.switchToHttp().getRequest<RequestLike>();
        const headers = req.headers ?? {};

        const provided = extractToken(headers);
        if (provided === undefined) {
            throw new UnauthorizedException(
                'Missing CLI token (Authorization: Bearer <token> or X-EW-CLI-Token header)',
            );
        }

        if (!tokenMatches(provided, this.token)) {
            throw new UnauthorizedException('Invalid CLI token');
        }

        return true;
    }
}

/**
 * Pulls the candidate token out of the request headers. Prefers the dedicated
 * `X-EW-CLI-Token` header, then falls back to `Authorization: Bearer <token>`.
 * Returns `undefined` when no credential is present.
 */
function extractToken(headers: Record<string, string | string[] | undefined>): string | undefined {
    const cliHeader = singleHeader(headers['x-ev-cli-token'] ?? headers['x-ew-cli-token']);
    if (typeof cliHeader === 'string' && cliHeader.length > 0) {
        return cliHeader;
    }

    const authHeader = singleHeader(headers['authorization']);
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        const value = authHeader.slice('Bearer '.length).trim();
        if (value.length > 0) {
            return value;
        }
    }

    return undefined;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
        return value[0];
    }
    return value;
}

/**
 * Constant-time token comparison. Always runs `timingSafeEqual` against an
 * equal-length buffer so the comparison cost is uniform regardless of the
 * submitted token's length — a naive `length !== length || !timingSafeEqual`
 * short-circuit would let a timing attacker binary-search the secret's byte
 * length. Mirrors `PlatformSecretGuard`.
 */
function tokenMatches(provided: string, expected: string): boolean {
    const expectedBuf = Buffer.from(expected, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');

    const lengthsMatch = expectedBuf.length === providedBuf.length;
    const comparisonBuf = lengthsMatch ? providedBuf : Buffer.alloc(expectedBuf.length);
    const bytesMatch = timingSafeEqual(expectedBuf, comparisonBuf);

    return lengthsMatch && bytesMatch;
}
