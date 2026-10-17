import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DomainEventCursorExpiredError } from '@ever-works/agent/domain-events';
import {
    DuplicateExternalRefError,
    IdempotencyConflictError,
    InvalidCursorError,
    ResourceNotFoundError,
    VersionMismatchError,
} from '@ever-works/agent/integrations-api';
import { IntegrationHttpException } from '../../../auth/integration/integration-http.exception';
import { IntegrationEventsController } from '../events.controller';
import { IntegrationExceptionFilter } from '../integration-exception.filter';
import { linkSourceOf, listParam, parseLimit, parseUpdatedSince } from '../integration-request';

/**
 * Integration API v1 read routes (EW-P1-4): the error envelope every route
 * answers, the request parsing helpers, and the change-feed route.
 */
describe('integration API v1 read routes', () => {
    describe('IntegrationExceptionFilter', () => {
        const filter = new IntegrationExceptionFilter();
        const envelope = (error: unknown) => filter.toEnvelope(error);

        it('passes IntegrationHttpException through', () => {
            expect(envelope(new IntegrationHttpException(403, 'org_not_pinned', 'nope'))).toEqual({
                status: 403,
                code: 'org_not_pinned',
                message: 'nope',
                details: undefined,
            });
        });

        it('maps the building blocks errors to their contract codes', () => {
            expect(envelope(new DomainEventCursorExpiredError('5', '10'))).toMatchObject({
                status: 410,
                code: 'cursor_expired',
                details: { after: '5', floor: '10' },
            });
            expect(envelope(new InvalidCursorError())).toMatchObject({
                status: 400,
                code: 'validation_failed',
            });
            expect(envelope(new VersionMismatchError(3, 4))).toMatchObject({
                status: 412,
                code: 'version_mismatch',
                details: { expected: 3, current: 4 },
            });
            expect(envelope(new DuplicateExternalRefError('external', 'e-1', 'x-1'))).toMatchObject(
                {
                    status: 409,
                    code: 'duplicate_external_ref',
                },
            );
            expect(envelope(new IdempotencyConflictError('in_progress'))).toMatchObject({
                status: 409,
                code: 'conflict',
                details: { reason: 'in_progress' },
            });
            expect(envelope(new ResourceNotFoundError('task', 't-1'))).toMatchObject({
                status: 404,
                code: 'not_found',
            });
        });

        it('maps plain HttpExceptions by status; a 403 from a service answers 404', () => {
            expect(envelope(new NotFoundException('gone'))).toMatchObject({
                status: 404,
                code: 'not_found',
            });
            expect(envelope(new ForbiddenException('not yours'))).toMatchObject({
                status: 404,
                code: 'not_found',
            });
            expect(envelope(new BadRequestException(['title must be a string']))).toMatchObject({
                status: 400,
                code: 'validation_failed',
                details: { fields: [{ path: 'title', message: 'title must be a string' }] },
            });
        });

        it('answers 500 internal_error for anything else, without leaking it', () => {
            expect(envelope(new Error('db password is hunter2'))).toEqual({
                status: 500,
                code: 'internal_error',
                message: 'Internal error; retry with back-off.',
            });
        });
    });

    describe('request helpers', () => {
        it('parses list parameters', () => {
            expect(parseUpdatedSince('2026-10-16T05:00:00Z')?.toISOString()).toBe(
                '2026-10-16T05:00:00.000Z',
            );
            expect(parseUpdatedSince(undefined)).toBeNull();
            expect(() => parseUpdatedSince('yesterday')).toThrow(IntegrationHttpException);
            expect(parseLimit('50')).toBe(50);
            expect(() => parseLimit('-1')).toThrow(IntegrationHttpException);
            expect(listParam(['task.*,goal.*', ' team.created '])).toEqual([
                'task.*',
                'goal.*',
                'team.created',
            ]);
        });

        it('links an ever-gauzy key as source gauzy', () => {
            expect(linkSourceOf({ integrationKind: 'ever-gauzy' } as never)).toBe('gauzy');
            expect(linkSourceOf({ integrationKind: 'generic' } as never)).toBe('generic');
        });
    });

    describe('GET /events', () => {
        const principal = {
            keyId: 'k-1',
            allowedOrganizationIds: ['org-1', 'org-2'],
            integrationKind: 'ever-gauzy',
            scopes: ['events:read', 'inbox:read'],
        };
        const user = { userId: 'u-1', authMethod: 'integration', integration: principal } as never;
        const page = { events: [], nextCursor: null, hasMore: false, head: '7' };

        it('reads every pinned organization unless X-Scope-Slug narrows it to one', async () => {
            const feed = { readPage: jest.fn().mockResolvedValue(page) };
            const scope = {
                getScope: jest.fn().mockReturnValue({ tenantId: 't', organizationId: null }),
            };
            const controller = new IntegrationEventsController(feed as never, scope as never);
            await expect(
                controller.events(user, '12', '100', 'task.*', 'gauzy:conn-1'),
            ).resolves.toBe(page);
            expect(feed.readPage).toHaveBeenCalledWith({
                organizationIds: ['org-1', 'org-2'],
                after: '12',
                limit: 100,
                types: ['task.*'],
                excludeOrigins: ['gauzy:conn-1'],
                // The key's scopes gate the recipient-scoped domains (inbox, email).
                grantedScopes: ['events:read', 'inbox:read'],
            });
            scope.getScope.mockReturnValue({ tenantId: 't', organizationId: 'org-2' });
            await controller.events(user);
            expect(feed.readPage).toHaveBeenLastCalledWith(
                expect.objectContaining({ organizationIds: ['org-2'], after: '0' }),
            );
        });

        it('refuses an after that is not a feed position', async () => {
            const controller = new IntegrationEventsController(
                { readPage: jest.fn() } as never,
                { getScope: () => ({ organizationId: null }) } as never,
            );
            await expect(controller.events(user, 'abc')).rejects.toBeInstanceOf(
                IntegrationHttpException,
            );
        });
    });
});
