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
 * Authenticates EW-120 ingest requests using the platform-wide bearer
 * token already injected into every directory-web-template deploy as
 * `PLATFORM_API_SECRET_TOKEN`. The template echoes the same value as
 * `Authorization: Bearer <token>` when POSTing to the ingest endpoint.
 *
 * Comparison is constant-time (`timingSafeEqual`) so attackers can't
 * recover the secret via timing side-channels.
 */
@Injectable()
export class PlatformSecretGuard implements CanActivate {
    private readonly logger = new Logger(PlatformSecretGuard.name);

    canActivate(context: ExecutionContext): boolean {
        const expected = process.env.PLATFORM_API_SECRET_TOKEN;
        if (!expected) {
            // No token configured (dev/CI without the secret): treat as
            // "no caller can authenticate" rather than 503. This keeps
            // the ingest endpoint's failure mode 401 in every env, which
            // is also what the e2e contract pins (activity-log-export
            // spec expects 401/403 for unauth ingest).
            this.logger.warn(
                'PLATFORM_API_SECRET_TOKEN is not configured; rejecting ingest request as unauthorized',
            );
            throw new UnauthorizedException('Ingest endpoint not configured');
        }

        const req = context.switchToHttp().getRequest<RequestLike>();
        const raw = req.headers['authorization'];
        const header = Array.isArray(raw) ? raw[0] : raw;
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
            throw new UnauthorizedException('Missing Bearer token');
        }
        const provided = header.slice('Bearer '.length).trim();

        const expectedBuf = Buffer.from(expected, 'utf8');
        const providedBuf = Buffer.from(provided, 'utf8');

        // Always call `timingSafeEqual` against an equal-length buffer so
        // the comparison cost is uniform regardless of the submitted
        // token length. A naive `length !== length || !timingSafeEqual`
        // short-circuit lets a timing attacker binary-search the secret's
        // byte length by varying the provided token's length, because the
        // observable code path differs (one branch runs the comparison,
        // the other doesn't).
        const lengthsMatch = expectedBuf.length === providedBuf.length;
        const comparisonBuf = lengthsMatch ? providedBuf : Buffer.alloc(expectedBuf.length);
        const bytesMatch = timingSafeEqual(expectedBuf, comparisonBuf);

        if (!lengthsMatch || !bytesMatch) {
            throw new UnauthorizedException('Invalid bearer token');
        }
        return true;
    }
}
