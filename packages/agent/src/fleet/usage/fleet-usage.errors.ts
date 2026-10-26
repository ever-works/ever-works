import { HttpException } from '@nestjs/common';
import {
    FLEET_LINK_ERROR_HTTP_STATUS,
    makeFleetLinkError,
    type FleetLinkError,
    type FleetLinkErrorCode,
} from '@ever-works/contracts';

/**
 * Usage & cost on the fleet (FL-20) — the one typed refusal the usage services
 * throw (CONTRACTS §8, spec FR-18). Its HTTP body is exactly the shared
 * envelope `{ error: { code, hint, details } }` with the status CONTRACTS
 * assigns the code — the same body the checkout and session refusals carry.
 */
export class FleetUsageException extends HttpException {
    readonly usageError: FleetLinkError;

    constructor(error: FleetLinkError) {
        super({ error }, FLEET_LINK_ERROR_HTTP_STATUS[error.code]);
        this.usageError = error;
        this.name = 'FleetUsageException';
    }

    get code(): FleetLinkErrorCode {
        return this.usageError.code;
    }
}

export function fleetUsageError(
    code: FleetLinkErrorCode,
    hint: string,
    details?: Record<string, unknown>,
): FleetUsageException {
    return new FleetUsageException(makeFleetLinkError(code, hint, details));
}
