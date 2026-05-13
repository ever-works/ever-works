import {
    CanActivate,
    ExecutionContext,
    Injectable,
    Logger,
    ServiceUnavailableException,
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
            this.logger.error(
                'PLATFORM_API_SECRET_TOKEN is not configured; rejecting ingest request',
            );
            throw new ServiceUnavailableException('Ingest endpoint not configured');
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
        if (
            expectedBuf.length !== providedBuf.length ||
            !timingSafeEqual(expectedBuf, providedBuf)
        ) {
            throw new UnauthorizedException('Invalid bearer token');
        }
        return true;
    }
}
