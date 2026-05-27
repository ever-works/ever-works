import type { DataSource, EntityMetadata, InsertEvent } from 'typeorm';
import { ScopeContextService } from '../scope-context.service';
import { ScopeStampingSubscriber } from '../scope-stamping.subscriber';

/**
 * Unit tests for the ScopeStampingSubscriber's `beforeInsert` hook.
 *
 * The subscriber is tested in isolation against fabricated
 * `InsertEvent` objects rather than via a live TypeORM DataSource —
 * the contract under test is purely "given this scope and this entity
 * shape, what does the subscriber write onto the entity object". Live
 * TypeORM integration is covered by the agent-package
 * `work-proposal.entity.integration.spec.ts` family.
 */
function makeEvent(
    entity: Record<string, unknown> | undefined,
    columnNames: string[],
): InsertEvent<unknown> {
    return {
        entity,
        metadata: {
            columns: columnNames.map((propertyName) => ({ propertyName })),
        } as unknown as EntityMetadata,
    } as InsertEvent<unknown>;
}

describe('ScopeStampingSubscriber (EW-657 Phase 5b)', () => {
    let scopeContext: ScopeContextService;
    let subscriber: ScopeStampingSubscriber;

    beforeEach(() => {
        scopeContext = new ScopeContextService();
        subscriber = new ScopeStampingSubscriber(
            // The DataSource is only used in onModuleInit; beforeInsert
            // doesn't touch it. Pass a stub so we don't depend on a
            // live connection.
            { subscribers: [] } as unknown as DataSource,
            scopeContext,
        );
    });

    describe('Tier C entity (has both tenantId + organizationId columns)', () => {
        const tierCColumns = ['id', 'tenantId', 'organizationId', 'createdAt'];

        it('stamps both columns from the active scope when entity has neither set', () => {
            const entity: Record<string, unknown> = { id: 'x' };
            scopeContext.runWith({ tenantId: 't-1', organizationId: 'o-1' }, () => {
                subscriber.beforeInsert(makeEvent(entity, tierCColumns));
            });
            expect(entity.tenantId).toBe('t-1');
            expect(entity.organizationId).toBe('o-1');
        });

        it('stamps null when no scope is active (outside runWith)', () => {
            const entity: Record<string, unknown> = { id: 'x' };
            subscriber.beforeInsert(makeEvent(entity, tierCColumns));
            expect(entity.tenantId).toBeNull();
            expect(entity.organizationId).toBeNull();
        });

        it('does NOT overwrite an already-set tenantId (explicit > implicit)', () => {
            const entity: Record<string, unknown> = {
                id: 'x',
                tenantId: 'explicit-t',
                organizationId: 'explicit-o',
            };
            scopeContext.runWith({ tenantId: 'scope-t', organizationId: 'scope-o' }, () => {
                subscriber.beforeInsert(makeEvent(entity, tierCColumns));
            });
            expect(entity.tenantId).toBe('explicit-t');
            expect(entity.organizationId).toBe('explicit-o');
        });

        it('treats explicit null as a deliberate choice and does NOT overwrite', () => {
            const entity: Record<string, unknown> = {
                id: 'x',
                tenantId: null,
                organizationId: null,
            };
            scopeContext.runWith({ tenantId: 't-1', organizationId: 'o-1' }, () => {
                subscriber.beforeInsert(makeEvent(entity, tierCColumns));
            });
            expect(entity.tenantId).toBeNull();
            expect(entity.organizationId).toBeNull();
        });

        it('stamps each column independently — partial pre-set is respected', () => {
            const entity: Record<string, unknown> = { id: 'x', tenantId: 'explicit-t' };
            scopeContext.runWith({ tenantId: 'scope-t', organizationId: 'scope-o' }, () => {
                subscriber.beforeInsert(makeEvent(entity, tierCColumns));
            });
            expect(entity.tenantId).toBe('explicit-t');
            expect(entity.organizationId).toBe('scope-o');
        });
    });

    describe('Tier B entity (has tenantId only)', () => {
        it('is skipped — neither column is stamped', () => {
            const entity: Record<string, unknown> = { id: 'x' };
            scopeContext.runWith({ tenantId: 't-1', organizationId: 'o-1' }, () => {
                subscriber.beforeInsert(
                    makeEvent(entity, ['id', 'tenantId', 'userId', 'createdAt']),
                );
            });
            // Subscriber writes neither — leaves the entity untouched.
            // Tier B sees explicit service-layer writes in Phase 5b too.
            expect(entity.tenantId).toBeUndefined();
            expect(entity.organizationId).toBeUndefined();
        });
    });

    describe('entity with neither column (pure cross-table join row, etc.)', () => {
        it('is skipped — neither column is stamped', () => {
            const entity: Record<string, unknown> = { id: 'x' };
            scopeContext.runWith({ tenantId: 't-1', organizationId: 'o-1' }, () => {
                subscriber.beforeInsert(makeEvent(entity, ['id', 'leftId', 'rightId']));
            });
            expect(entity.tenantId).toBeUndefined();
            expect(entity.organizationId).toBeUndefined();
        });
    });

    describe('defensive', () => {
        it('returns silently when event.entity is undefined', () => {
            const tierCColumns = ['id', 'tenantId', 'organizationId'];
            expect(() => {
                subscriber.beforeInsert(makeEvent(undefined, tierCColumns));
            }).not.toThrow();
        });
    });
});
