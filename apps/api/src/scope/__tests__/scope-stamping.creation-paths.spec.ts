import { Agent, Goal, Mission, Work } from '@ever-works/agent/entities';
import {
    getMetadataArgsStorage,
    type DataSource,
    type EntityMetadata,
    type InsertEvent,
} from 'typeorm';
import { ScopeContextService } from '../scope-context.service';
import { ScopeStampingSubscriber } from '../scope-stamping.subscriber';

const TIER_C_ENTITIES = [
    ['Mission', Mission],
    ['Goal', Goal],
    ['Work', Work],
    ['Agent', Agent],
] as const;

function makeEvent(entity: object): InsertEvent<unknown> {
    return {
        entity,
        metadata: {
            columns: ['id', 'tenantId', 'organizationId'].map((propertyName) => ({
                propertyName,
            })),
        } as unknown as EntityMetadata,
    } as InsertEvent<unknown>;
}

describe('Scope stamping across Mission/Goal/Work/Agent creation paths', () => {
    const tenantId = 'tenant-ever';
    const organizationId = 'organization-ever';

    it.each(TIER_C_ENTITIES)(
        '%s exposes the real nullable scope columns and is stamped through the subscriber',
        (domain, Entity) => {
            const columns = getMetadataArgsStorage()
                .filterColumns(Entity)
                .map((column) => column.propertyName);
            expect(columns).toEqual(expect.arrayContaining(['tenantId', 'organizationId']));

            // Use an actual entity prototype so this is a runtime contract, not
            // a source-signature search tied to a service method's formatting.
            const row = Object.assign(Object.create(Entity.prototype), {
                id: `${domain.toLowerCase()}-1`,
            }) as InstanceType<typeof Entity> & {
                tenantId?: string | null;
                organizationId?: string | null;
            };
            const scopeContext = new ScopeContextService();
            const subscriber = new ScopeStampingSubscriber(
                { subscribers: [] } as unknown as DataSource,
                scopeContext,
            );

            scopeContext.runWith({ tenantId, organizationId }, () => {
                subscriber.beforeInsert(makeEvent(row));
            });

            expect(row).toMatchObject({ tenantId, organizationId });
        },
    );
});
