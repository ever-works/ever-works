import { HttpException } from '@nestjs/common';
import {
    FLEET_LINK_ERROR_HTTP_STATUS,
    isFleetLinkErrorCode,
    makeFleetLinkError,
    type FleetLinkError,
    type FleetLinkErrorCode,
} from '@ever-works/contracts';

/**
 * Sessions on computers (FL-04) — the one typed refusal the session service
 * throws (CONTRACTS §8). Its HTTP body is exactly the shared envelope
 * `{ error: { code, hint, details } }` with the status CONTRACTS assigns the
 * code — the same body the link's own refusals carry — so a REST caller, an
 * Agent tool and the CLI all read one shape.
 */
export class FleetSessionException extends HttpException {
    readonly sessionError: FleetLinkError;

    constructor(error: FleetLinkError) {
        super({ error }, FLEET_LINK_ERROR_HTTP_STATUS[error.code]);
        this.sessionError = error;
        this.name = 'FleetSessionException';
    }

    get code(): FleetLinkErrorCode {
        return this.sessionError.code;
    }
}

export function fleetSessionError(
    code: FleetLinkErrorCode,
    hint: string,
    details?: Record<string, unknown>,
): FleetSessionException {
    return new FleetSessionException(makeFleetLinkError(code, hint, details));
}

/**
 * The CONTRACTS §8 error inside anything thrown at us: our own exception, the
 * link's (`{ error: { code, hint } }` as an HttpException body), or null when
 * it is not one (a bug, a driver error).
 */
export function readFleetSessionError(thrown: unknown): FleetLinkError | null {
    if (thrown instanceof FleetSessionException) return thrown.sessionError;
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
