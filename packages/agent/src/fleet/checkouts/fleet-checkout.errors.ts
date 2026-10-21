import { HttpException } from '@nestjs/common';
import {
    FLEET_LINK_ERROR_HTTP_STATUS,
    makeFleetLinkError,
    type FleetLinkError,
    type FleetLinkErrorCode,
} from '@ever-works/contracts';

/**
 * Checkouts on computers (FL-14) — the one typed refusal the checkout service
 * throws (CONTRACTS §8). Its HTTP body is exactly the shared envelope
 * `{ error: { code, hint, details } }` with the status CONTRACTS assigns the
 * code — the same body the link's and the session service's refusals carry
 * (read any of them with `readFleetSessionError`).
 */
export class FleetCheckoutException extends HttpException {
    readonly checkoutError: FleetLinkError;

    constructor(error: FleetLinkError) {
        super({ error }, FLEET_LINK_ERROR_HTTP_STATUS[error.code]);
        this.checkoutError = error;
        this.name = 'FleetCheckoutException';
    }

    get code(): FleetLinkErrorCode {
        return this.checkoutError.code;
    }
}

export function fleetCheckoutError(
    code: FleetLinkErrorCode,
    hint: string,
    details?: Record<string, unknown>,
): FleetCheckoutException {
    return new FleetCheckoutException(makeFleetLinkError(code, hint, details));
}
