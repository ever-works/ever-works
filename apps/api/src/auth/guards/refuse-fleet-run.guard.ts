import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { isFleetRunRequest, type MachinePrincipalRequest } from '../machine-principal';

/**
 * Works-security lane 3a (2026-10-18) — refuses a FLEET-RUN token on the
 * route it decorates, whatever the run-token route list says.
 *
 * The list in `@ever-works/contracts` (`FLEET_RUN_TOKEN_ROUTES`) is the
 * primary control and already omits these routes; this guard is the second,
 * local layer for routes whose whole purpose is configuration a later run
 * would inherit (a plugin's enablement or settings: a base URL there can
 * redirect every model call), so a future edit of the list cannot silently
 * re-open them. Every other credential — a session, a personal API key —
 * passes untouched. Runs after the global `AuthSessionGuard`, which stashes
 * `request.fleetRunCredential` for a run token.
 */
@Injectable()
export class RefuseFleetRunGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<MachinePrincipalRequest>();
        if (isFleetRunRequest(request)) {
            throw new ForbiddenException(
                'A fleet-run credential cannot change plugin configuration; a person does it in the app.',
            );
        }
        return true;
    }
}
