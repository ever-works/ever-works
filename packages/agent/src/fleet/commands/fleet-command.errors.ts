import { HttpException } from '@nestjs/common';
import {
    FLEET_LINK_ERROR_HTTP_STATUS,
    isFleetLinkErrorCode,
    makeFleetLinkError,
    type FleetLinkError,
    type FleetLinkErrorCode,
} from '@ever-works/contracts';

/**
 * Commands on computers (FL-12) — the one typed refusal the command service
 * throws (CONTRACTS §8). Its HTTP body is exactly the shared envelope
 * `{ error: { code, hint, details } }` with the status CONTRACTS assigns the
 * code, so a REST caller, an Agent tool and the CLI read one shape — the
 * same body the link's own refusals and the session service's carry.
 */
export class FleetCommandException extends HttpException {
    readonly commandError: FleetLinkError;

    constructor(error: FleetLinkError) {
        super({ error }, FLEET_LINK_ERROR_HTTP_STATUS[error.code]);
        this.commandError = error;
        this.name = 'FleetCommandException';
    }

    get code(): FleetLinkErrorCode {
        return this.commandError.code;
    }
}

export function fleetCommandError(
    code: FleetLinkErrorCode,
    hint: string,
    details?: Record<string, unknown>,
): FleetCommandException {
    return new FleetCommandException(makeFleetLinkError(code, hint, details));
}

/**
 * The CONTRACTS §8 error inside anything thrown at us: our own exception, the
 * link's or any other `{ error: { code, hint } }` HttpException body, or null
 * when it is not one (a bug, a driver error).
 */
export function readFleetCommandError(thrown: unknown): FleetLinkError | null {
    if (thrown instanceof FleetCommandException) return thrown.commandError;
    if (thrown instanceof HttpException) {
        const body = thrown.getResponse() as { error?: unknown } | string;
        const error =
            typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : null;
        if (
            typeof error === 'object' &&
            error !== null &&
            isFleetLinkErrorCode((error as { code?: unknown }).code) &&
            typeof (error as { hint?: unknown }).hint === 'string'
        ) {
            return error as FleetLinkError;
        }
    }
    return null;
}
