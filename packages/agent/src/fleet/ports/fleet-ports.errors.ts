import { HttpException } from '@nestjs/common';
import {
    FLEET_LINK_ERROR_HTTP_STATUS,
    isFleetLinkErrorCode,
    makeFleetLinkError,
    type FleetLinkError,
    type FleetLinkErrorCode,
} from '@ever-works/contracts';

/**
 * Servers and ports (FL-10) — the one typed refusal the ports services throw
 * (CONTRACTS §8): its HTTP body is the shared `{ error: { code, hint, details } }`
 * envelope with the status CONTRACTS assigns the code, the same body the
 * link's own refusals carry, so the tab, an Agent tool and the CLI read one
 * shape.
 */
export class FleetPortsException extends HttpException {
    readonly portsError: FleetLinkError;

    constructor(error: FleetLinkError) {
        super({ error }, FLEET_LINK_ERROR_HTTP_STATUS[error.code]);
        this.portsError = error;
        this.name = 'FleetPortsException';
    }

    get code(): FleetLinkErrorCode {
        return this.portsError.code;
    }
}

export function fleetPortsError(
    code: FleetLinkErrorCode,
    hint: string,
    details?: Record<string, unknown>,
): FleetPortsException {
    return new FleetPortsException(makeFleetLinkError(code, hint, details));
}

/**
 * The CONTRACTS §8 error inside anything thrown at us — ours, the link's (an
 * HttpException whose body is the envelope), the access service's 403 body —
 * or null when it is not one.
 */
export function readFleetPortsError(thrown: unknown): FleetLinkError | null {
    if (thrown instanceof FleetPortsException) return thrown.portsError;
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
        if (thrown.getStatus() === 404) return makeFleetLinkError('not_found', 'no such computer');
        if (thrown.getStatus() === 403) {
            return makeFleetLinkError('permission_denied', 'ask the owner of this computer to allow you');
        }
    }
    return null;
}
