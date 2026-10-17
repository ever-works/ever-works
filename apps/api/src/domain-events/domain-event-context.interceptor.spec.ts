import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { getDomainEventContext } from '@ever-works/agent/domain-events';
import { lastValueFrom, Observable } from 'rxjs';
import {
    DomainEventContextInterceptor,
    domainEventContextFromRequest,
    integrationActorLabel,
} from './domain-event-context.interceptor';

describe('domainEventContextFromRequest', () => {
    it('attributes a session or personal-key request to its user', () => {
        expect(
            domainEventContextFromRequest({
                user: { userId: 'u-1', username: 'ruslan', authMethod: 'session' },
                headers: { 'x-sync-origin': 'gauzy:conn-1', 'x-request-id': 'req-1' },
            }),
        ).toEqual({
            actor: { type: 'user', id: 'u-1', label: 'ruslan' },
            originTag: 'gauzy:conn-1',
            integrationKeyId: null,
            correlationId: 'req-1',
        });
    });

    it('attributes an integration request to its key, labelled by integration kind', () => {
        const context = domainEventContextFromRequest({
            user: {
                userId: 'owner-1',
                authMethod: 'integration',
                integration: {
                    keyId: 'key-1',
                    keyName: 'Acme',
                    integrationKind: 'ever-gauzy',
                    actAsUserId: null,
                },
            },
            headers: { 'x-sync-origin': 'gauzy:conn-9' },
        });
        expect(context).toEqual({
            actor: { type: 'integration', id: 'key-1', label: 'Ever Gauzy (Acme)' },
            originTag: 'gauzy:conn-9',
            integrationKeyId: 'key-1',
            correlationId: null,
        });
    });

    it('attributes an act-as write to the acting user, keeping the key as the means', () => {
        const context = domainEventContextFromRequest({
            user: {
                userId: 'u-7',
                authMethod: 'integration',
                integration: {
                    keyId: 'key-1',
                    keyName: 'Acme',
                    integrationKind: 'ever-gauzy',
                    actAsUserId: 'u-7',
                },
            },
        });
        expect(context.actor).toEqual({ type: 'user', id: 'u-7', label: null });
        expect(context.integrationKeyId).toBe('key-1');
    });

    it('drops an invalid X-Sync-Origin and an oversized request id', () => {
        const context = domainEventContextFromRequest({
            headers: { 'x-sync-origin': 'bad value with spaces', 'x-request-id': 'x'.repeat(101) },
        });
        expect(context).toEqual({
            actor: undefined,
            originTag: null,
            integrationKeyId: null,
            correlationId: null,
        });
    });

    it('labels generic integrations generically', () => {
        expect(integrationActorLabel('generic', 'ETL')).toBe('Integration (ETL)');
        expect(integrationActorLabel(undefined, undefined)).toBe('Integration (key)');
    });
});

describe('DomainEventContextInterceptor', () => {
    const httpContext = (request: unknown): ExecutionContext =>
        ({
            getType: () => 'http',
            switchToHttp: () => ({ getRequest: () => request }),
        }) as unknown as ExecutionContext;

    it('runs the handler — including its async continuations — inside the request context', async () => {
        const interceptor = new DomainEventContextInterceptor();
        const handler: CallHandler = {
            handle: () =>
                new Observable((subscriber) => {
                    void (async () => {
                        await new Promise((resolve) => setTimeout(resolve, 5));
                        subscriber.next(getDomainEventContext());
                        subscriber.complete();
                    })();
                }),
        };
        const seen = await lastValueFrom(
            interceptor.intercept(
                httpContext({
                    user: { userId: 'u-1', username: 'ruslan' },
                    headers: { 'x-sync-origin': 'gauzy:c' },
                }),
                handler,
            ),
        );
        expect(seen).toMatchObject({ actor: { type: 'user', id: 'u-1' }, originTag: 'gauzy:c' });
        expect(getDomainEventContext()).toBeUndefined();
    });

    it('passes non-HTTP contexts straight through', async () => {
        const interceptor = new DomainEventContextInterceptor();
        const handler: CallHandler = {
            handle: () => new Observable((s) => (s.next('ok'), s.complete())),
        };
        const result = await lastValueFrom(
            interceptor.intercept({ getType: () => 'rpc' } as unknown as ExecutionContext, handler),
        );
        expect(result).toBe('ok');
    });
});
