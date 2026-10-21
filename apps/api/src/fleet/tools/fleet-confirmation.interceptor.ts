import {
    HttpException,
    HttpStatus,
    Injectable,
    type CallHandler,
    type ExecutionContext,
    type NestInterceptor,
} from '@nestjs/common';
import { catchError, throwError, type Observable } from 'rxjs';
import {
    FLEET_TOOL_CATALOGUE,
    FLEET_TOOL_COPY,
    isFleetConfirmationClass,
    type FleetConfirmationClass,
    type FleetToolCatalogueEntry,
} from '@ever-works/contracts';

/**
 * FL-19 T-08 (plan §5, CONTRACTS §2.2) — one confirmation mechanism for every
 * caller. The web, Agent tools, MCP and the CLI satisfy a class with the same
 * request fields (`confirm`, `confirmName`, `acknowledgeBlastRadius`); a call
 * without them answers 409 `confirmation_required` with
 * `details: { class, summary, preview?, sentence? }`. Each family service
 * decides WHETHER a call is confirmed (it alone knows the target's name and
 * the node's blast-radius warning, evaluated on every call — no tokens, nothing
 * stored between the two calls). This interceptor makes the ANSWER uniform:
 *
 *  - before the handler: a token-style field a caller invented
 *    (`confirmationToken`, `confirmation_token`) is dropped, so it is ignored
 *    rather than 400-ing on a whitelisting pipe — and never mistaken for a
 *    confirmation (the call still answers 409 with the preview);
 *  - on a 409 `confirmation_required`: `details.class` is filled from the
 *    catalogue row of the route when the service left it out, and the `hint`
 *    says exactly what to send ("call again with confirm: true", "type the
 *    exact name: win-11-vm", the blast-radius acknowledgement).
 *
 * Applied per controller with `@UseInterceptors(FleetConfirmationInterceptor)`;
 * a route that never asks for confirmation is untouched.
 */

/** Fields that look like a confirmation token. CONTRACTS §2.2 has none; they are dropped. */
export const FLEET_CONFIRMATION_TOKEN_FIELDS: readonly string[] = Object.freeze([
    'confirmationToken',
    'confirmation_token',
    'confirmToken',
]);

/** `/api/fleet/nodes/:id/x` and `/api/fleet/nodes/{id}/x` → the same shape. */
function routeShape(path: string): string {
    return path.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z0-9_]+/g, '{}').replace(/\/+$/, '');
}

const ROUTES: ReadonlyMap<string, FleetToolCatalogueEntry> = new Map(
    FLEET_TOOL_CATALOGUE.filter((entry) => entry.route && !entry.readOnly).map((entry) => [
        `${entry.route!.method} ${routeShape(entry.route!.path)}`,
        entry,
    ]),
);

/** The catalogue row of a request's route, or undefined. */
export function fleetCatalogueEntryForRoute(method: string, routePath: string): FleetToolCatalogueEntry | undefined {
    return ROUTES.get(`${method.toUpperCase()} ${routeShape(routePath)}`);
}

/** The hint that says exactly what the confirming call sends. */
export function fleetConfirmationHint(klass: FleetConfirmationClass, name?: string | null): string {
    if (klass === 'confirm-destructive') return FLEET_TOOL_COPY.confirmName(name ?? '<name>');
    if (klass === 'blast-radius') return FLEET_TOOL_COPY.acknowledge();
    return FLEET_TOOL_COPY.confirm();
}

/** Remove token-style fields from a body in place (an object body only). */
export function stripFleetConfirmationTokens(body: unknown): void {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return;
    for (const field of FLEET_CONFIRMATION_TOKEN_FIELDS) {
        if (field in (body as Record<string, unknown>)) delete (body as Record<string, unknown>)[field];
    }
}

/**
 * The 409 body with `details.class` and a `hint` filled in, or null when the
 * exception is not a `confirmation_required` refusal.
 */
export function completeFleetConfirmationBody(
    response: unknown,
    entry: FleetToolCatalogueEntry | undefined,
): Record<string, unknown> | null {
    if (!response || typeof response !== 'object') return null;
    const body = response as { error?: { code?: unknown; hint?: unknown; details?: unknown } };
    if (!body.error || body.error.code !== 'confirmation_required') return null;
    const details =
        body.error.details && typeof body.error.details === 'object'
            ? { ...(body.error.details as Record<string, unknown>) }
            : {};
    const klass = isFleetConfirmationClass(details.class)
        ? details.class
        : (entry?.confirmationClass ?? 'confirm');
    details.class = klass;
    const name = typeof details.name === 'string' ? details.name : typeof details.target === 'string' ? details.target : null;
    const hint =
        typeof body.error.hint === 'string' && body.error.hint.trim().length > 0
            ? body.error.hint
            : fleetConfirmationHint(klass, name);
    return { ...(response as Record<string, unknown>), error: { ...body.error, code: 'confirmation_required', hint, details } };
}

@Injectable()
export class FleetConfirmationInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const request = context.switchToHttp().getRequest<{
            method?: string;
            body?: unknown;
            route?: { path?: string };
        }>();
        stripFleetConfirmationTokens(request?.body);
        const entry =
            request?.method && request.route?.path
                ? fleetCatalogueEntryForRoute(request.method, request.route.path)
                : undefined;
        return next.handle().pipe(
            catchError((error: unknown) => {
                if (!(error instanceof HttpException) || error.getStatus() !== HttpStatus.CONFLICT) {
                    return throwError(() => error);
                }
                const completed = completeFleetConfirmationBody(error.getResponse(), entry);
                if (!completed) return throwError(() => error);
                return throwError(() => new HttpException(completed, HttpStatus.CONFLICT));
            }),
        );
    }
}
