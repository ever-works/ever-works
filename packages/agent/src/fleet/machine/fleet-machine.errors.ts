import { HttpException } from '@nestjs/common';
import {
    FLEET_LINK_ERROR_HTTP_STATUS,
    isFleetLinkErrorCode,
    makeFleetLinkError,
    type FleetLinkError,
    type FleetLinkErrorCode,
} from '@ever-works/contracts';

/**
 * Machine actions (FL-09) — the one typed refusal the services, processes
 * and Docker surfaces throw (CONTRACTS §8). Its HTTP body is exactly the
 * shared envelope `{ error: { code, hint, details } }` with the status
 * CONTRACTS assigns the code (`root_required` and `confirmation_required`
 * are 409), so the web, an Agent tool, MCP and the CLI read one shape.
 */
export class FleetMachineException extends HttpException {
    readonly machineError: FleetLinkError;

    constructor(error: FleetLinkError) {
        super({ error }, FLEET_LINK_ERROR_HTTP_STATUS[error.code]);
        this.machineError = error;
        this.name = 'FleetMachineException';
    }

    get code(): FleetLinkErrorCode {
        return this.machineError.code;
    }
}

export function fleetMachineError(
    code: FleetLinkErrorCode,
    hint: string,
    details?: Record<string, unknown>,
): FleetMachineException {
    return new FleetMachineException(makeFleetLinkError(code, hint, details));
}

/**
 * The CONTRACTS §8 error inside anything thrown at us — our own exception,
 * the link's or a session's (any `HttpException` whose body is the
 * envelope) — or null when it is not one (a bug, a driver error).
 */
export function readFleetMachineError(thrown: unknown): FleetLinkError | null {
    if (thrown instanceof FleetMachineException) return thrown.machineError;
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
