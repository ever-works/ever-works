import {
    CallHandler,
    ExecutionContext,
    Injectable,
    Logger,
    NestInterceptor,
    Optional,
} from '@nestjs/common';
import { Observable, from, mergeMap } from 'rxjs';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import { INTEGRATION_HEADERS, integrationActorLabel } from '@ever-works/contracts';
import { ScopeContextService } from '../../scope/scope-context.service';
import type { AuthenticatedUser } from '../types/auth.types';
import { isWriteMethod } from './integration-limits';

type AuditedRequest = {
    method?: string;
    path?: string;
    originalUrl?: string;
    baseUrl?: string;
    route?: { path?: string };
    headers?: Record<string, string | string[] | undefined>;
    user?: AuthenticatedUser;
};

/**
 * EW-P1-2 — every successful write made with an integration key leaves an
 * `activity_log` row (plan doc 02 §2 "Audit"):
 *
 * - `actionType = integration_write`, `actorKind = 'external'`,
 *   `actorLabel = 'Ever Gauzy (<key name>)'` (or `'Integration (<key name>)'`);
 * - `userId` = the user the write was made for (the validated act-as user,
 *   else the key's owner), so it shows in their Activity feed;
 * - `details` = `{ integrationKeyId, integrationKind, actAsUserId,
 *   ownerUserId, method, route, statusCode, originTag, resourceId }`.
 *
 * It sits on top of — never instead of — the domain's own rows (a Task
 * created through an integration still writes `task_created`). Registered as
 * an `APP_INTERCEPTOR`; a no-op for every other credential, for reads, and
 * for failed requests. Recording is best-effort: a failed insert is logged
 * and the caller still gets its response.
 */
@Injectable()
export class IntegrationAuditInterceptor implements NestInterceptor {
    private readonly logger = new Logger(IntegrationAuditInterceptor.name);

    constructor(
        private readonly scopeContext: ScopeContextService,
        @Optional() private readonly activityLog?: ActivityLogService,
    ) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        if (context.getType() !== 'http' || !this.activityLog) return next.handle();
        const request = context.switchToHttp().getRequest<AuditedRequest>();
        const user = request.user;
        if (
            user?.authMethod !== 'integration' ||
            !user.integration ||
            !isWriteMethod(request.method)
        ) {
            return next.handle();
        }
        const response = context.switchToHttp().getResponse<{ statusCode?: number }>();
        return next
            .handle()
            .pipe(
                mergeMap((body) =>
                    from(this.record(request, response?.statusCode ?? 200, body).then(() => body)),
                ),
            );
    }

    private async record(
        request: AuditedRequest,
        statusCode: number,
        body: unknown,
    ): Promise<void> {
        const user = request.user!;
        const principal = user.integration!;
        const label = integrationActorLabel(principal.integrationKind, principal.keyName);
        const method = (request.method ?? 'POST').toUpperCase();
        const route = routeOf(request);
        const scope = this.scopeContext.getScope();
        const originTag = firstHeader(request.headers?.[INTEGRATION_HEADERS.syncOrigin]);
        const resourceId =
            body && typeof body === 'object' && typeof (body as { id?: unknown }).id === 'string'
                ? (body as { id: string }).id
                : null;
        try {
            await this.activityLog!.log({
                userId: user.userId,
                actionType: ActivityActionType.INTEGRATION_WRITE,
                action: `${method} ${route}`.slice(0, 100),
                status: ActivityStatus.COMPLETED,
                summary: `${label}: ${method} ${route}`.slice(0, 500),
                details: {
                    integrationKeyId: principal.keyId,
                    integrationKind: principal.integrationKind,
                    actAsUserId: principal.actAsUserId,
                    ownerUserId: principal.ownerUserId,
                    method,
                    route,
                    statusCode,
                    originTag: originTag ? originTag.slice(0, 100) : null,
                    resourceId,
                },
                actorKind: 'external',
                actorLabel: label,
                tenantId: scope.tenantId ?? principal.tenantId,
                organizationId: scope.organizationId,
            });
        } catch (err) {
            this.logger.warn(
                `Failed to record integration write for key ${principal.keyId}: ${(err as Error).message}`,
            );
        }
    }
}

/** The matched route pattern (`/api/tasks/:id/chat`), never the raw URL with ids or a query. */
function routeOf(request: AuditedRequest): string {
    const pattern = request.route?.path;
    if (typeof pattern === 'string' && pattern.length > 0) {
        const base = typeof request.baseUrl === 'string' ? request.baseUrl : '';
        return `${base}${pattern}`;
    }
    const raw = request.path ?? request.originalUrl ?? '';
    return raw.split('?')[0];
}

function firstHeader(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}
