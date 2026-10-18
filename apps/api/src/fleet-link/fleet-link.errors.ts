import { HttpException } from '@nestjs/common';
import {
    FLEET_LINK_ERROR_HTTP_STATUS,
    makeFleetLinkError,
    type FleetLinkError,
    type FleetLinkErrorCode,
} from '@ever-works/contracts';

/**
 * Fleet node link — the one typed refusal every link surface throws
 * (CONTRACTS §8). Its HTTP body is exactly the shared envelope
 * `{ error: { code, hint, details } }`, with the status CONTRACTS assigns the
 * code, so a REST caller, an Agent tool and the CLI all read the same thing.
 */
export class FleetLinkException extends HttpException {
    readonly linkError: FleetLinkError;

    constructor(error: FleetLinkError) {
        super({ error }, FLEET_LINK_ERROR_HTTP_STATUS[error.code]);
        this.linkError = error;
        this.name = 'FleetLinkException';
    }

    get code(): FleetLinkErrorCode {
        return this.linkError.code;
    }
}

export function fleetLinkError(
    code: FleetLinkErrorCode,
    hint: string,
    details?: Record<string, unknown>,
): FleetLinkException {
    return new FleetLinkException(makeFleetLinkError(code, hint, details));
}

/** `12 min`, `3 h`, `2 d` — how long ago, for an `unreachable` hint. */
export function describeAgo(
    since: Date | string | null | undefined,
    now: number = Date.now(),
): string | null {
    if (!since) return null;
    const at = since instanceof Date ? since.getTime() : Date.parse(since);
    if (!Number.isFinite(at)) return null;
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    if (seconds < 90) return `${seconds} s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 90) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours} h`;
    return `${Math.round(hours / 24)} d`;
}
