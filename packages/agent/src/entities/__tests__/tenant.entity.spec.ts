import { getMetadataArgsStorage } from 'typeorm';
import { Tenant } from '../tenant.entity';

/**
 * EW-653 — shape tests for the `Tenant` entity. Mirrors the same
 * metadata-graph approach used by `agent.entity.spec.ts` —
 * no DataSource is spun up; we just assert the TypeORM decorator
 * graph matches Phase 1 of the
 * [Tenants & Organizations spec](../../../../../docs/specs/features/tenants-and-organizations/spec.md#11-tenant-internal-only-never-shown-in-ui).
 */
describe('Tenant entity', () => {
    const storage = getMetadataArgsStorage();
    const table = storage.tables.find((t) => t.target === Tenant);
    const columns = storage.columns.filter((c) => c.target === Tenant);
    const columnNames = columns.map((c) => c.propertyName);

    it('maps to the `tenants` table', () => {
        expect(table?.name).toBe('tenants');
    });

    it('declares all required columns', () => {
        expect(columnNames).toEqual(
            expect.arrayContaining([
                'id',
                'ownerUserId',
                'slug',
                'displayName',
                'createdAt',
                'updatedAt',
            ]),
        );
    });

    it('marks ownerUserId as unique (1:1 User:Tenant for v1)', () => {
        const col = columns.find((c) => c.propertyName === 'ownerUserId');
        expect(col?.options.unique).toBe(true);
    });

    it('marks ownerUserId and displayName as NOT nullable', () => {
        const owner = columns.find((c) => c.propertyName === 'ownerUserId');
        const display = columns.find((c) => c.propertyName === 'displayName');
        expect(owner?.options.nullable).not.toBe(true);
        expect(display?.options.nullable).not.toBe(true);
    });

    it('constrains slug column length (driven by migration)', () => {
        // Don't pin the exact value — TypeORM normalizes `length` to either a
        // number or string depending on dialect. Just assert it's set.
        const slug = columns.find((c) => c.propertyName === 'slug');
        expect(slug?.options.length).toBeDefined();
    });
});
