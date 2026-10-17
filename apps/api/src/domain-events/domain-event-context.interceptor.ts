import {
    type CallHandler,
    type ExecutionContext,
    Injectable,
    type NestInterceptor,
} from '@nestjs/common';
import type { DomainEventActor } from '@ever-works/contracts';
import {
    normalizeSyncOrigin,
    runWithDomainEventContext,
    type DomainEventContext,
} from '@ever-works/agent/domain-events';
import { Observable } from 'rxjs';

/** The parts of `request.user` the interceptor reads (set by the auth guards before any interceptor). */
interface PrincipalLike {
    userId?: string;
    username?: string | null;
    authMethod?: string;
    /** EW-P1-2 integration principal (`authMethod === 'integration'`). */
    integration?: {
        keyId?: string;
        keyName?: string;
        integrationKind?: string;
        actAsUserId?: string | null;
    } | null;
}

interface RequestLike {
    user?: PrincipalLike;
    headers?: Record<string, string | string[] | undefined>;
}

/** Display label of an integration actor, by kind (integration-keys spec §5). */
export function integrationActorLabel(
    kind: string | undefined,
    keyName: string | undefined,
): string {
    const name = keyName?.trim() || 'key';
    return kind === 'ever-gauzy' ? `Ever Gauzy (${name})` : `Integration (${name})`;
}

/** Who and what a request's changes are attributed to, for the events they record. */
export function domainEventContextFromRequest(
    request: RequestLike | undefined,
): DomainEventContext {
    const headers = request?.headers ?? {};
    const originTag = normalizeSyncOrigin(headers['x-sync-origin']);
    const requestId = headers['x-request-id'];
    const correlationId =
        typeof requestId === 'string' && requestId.length <= 100 ? requestId : null;

    const user = request?.user;
    let actor: DomainEventActor | undefined;
    let integrationKeyId: string | null = null;
    if (user?.authMethod === 'integration' && user.integration?.keyId) {
        const integration = user.integration;
        integrationKeyId = integration.keyId ?? null;
        actor = integration.actAsUserId
            ? { type: 'user', id: integration.actAsUserId, label: null }
            : {
                  type: 'integration',
                  id: integration.keyId as string,
                  label: integrationActorLabel(integration.integrationKind, integration.keyName),
              };
    } else if (user?.userId) {
        actor = { type: 'user', id: user.userId, label: user.username ?? null };
    }
    return { actor, originTag, integrationKeyId, correlationId };
}

/**
 * Domain events (EW-P1-1) — runs every HTTP handler inside a domain event
 * context, so the events its writes record carry the right actor (user, or
 * integration key / act-as user), the `X-Sync-Origin` loop-prevention tag and
 * the request id. Registered globally by `DomainEventsApiModule`.
 *
 * Interceptors run after the guards, so `request.user` is final here.
 */
@Injectable()
export class DomainEventContextInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        if (context.getType() !== 'http') return next.handle();
        const eventContext = domainEventContextFromRequest(
            context.switchToHttp().getRequest<RequestLike>(),
        );
        return new Observable((subscriber) =>
            runWithDomainEventContext(eventContext, () => next.handle().subscribe(subscriber)),
        );
    }
}
