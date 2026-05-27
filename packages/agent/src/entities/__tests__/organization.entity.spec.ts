import { getMetadataArgsStorage } from 'typeorm';
import { Organization } from '../organization.entity';

/**
 * EW-653 — shape tests for the `Organization` entity. See
 * [spec.md §1.2](../../../../../docs/specs/features/tenants-and-organizations/spec.md#12-organization-user-facing--ui-label-varies)
 * for the design.
 */
describe('Organization entity', () => {
    const storage = getMetadataArgsStorage();
    const table = storage.tables.find((t) => t.target === Organization);
    const columns = storage.columns.filter((c) => c.target === Organization);
    const indices = storage.indices.filter((i) => i.target === Organization);
    const columnNames = columns.map((c) => c.propertyName);

    it('maps to the `organizations` table', () => {
        expect(table?.name).toBe('organizations');
    });

    it('declares the full Phase 1 column set', () => {
        expect(columnNames).toEqual(
            expect.arrayContaining([
                'id',
                'tenantId',
                'slug',
                'legalName',
                'displayName',
                'countryCode',
                'registrationProvider',
                'registrationStatus',
                'linkedWorkId',
                'createdAt',
                'updatedAt',
            ]),
        );
    });

    it('marks slug as unique (globally across the table)', () => {
        const slug = columns.find((c) => c.propertyName === 'slug');
        expect(slug?.options.unique).toBe(true);
    });

    it('marks tenantId and displayName as NOT nullable', () => {
        const tenant = columns.find((c) => c.propertyName === 'tenantId');
        const display = columns.find((c) => c.propertyName === 'displayName');
        expect(tenant?.options.nullable).not.toBe(true);
        expect(display?.options.nullable).not.toBe(true);
    });

    it('marks legalName, countryCode, registrationProvider, linkedWorkId as nullable', () => {
        for (const name of ['legalName', 'countryCode', 'registrationProvider', 'linkedWorkId']) {
            const col = columns.find((c) => c.propertyName === name);
            expect(col?.options.nullable).toBe(true);
        }
    });

    it('defaults registrationStatus to "draft"', () => {
        const status = columns.find((c) => c.propertyName === 'registrationStatus');
        expect(status?.options.default).toBe('draft');
    });

    it('declares the (tenantId, createdAt) composite index for switcher list queries', () => {
        const idx = indices.find((i) => i.name === 'idx_organizations_tenant_created');
        expect(idx).toBeDefined();
        expect(idx?.columns).toEqual(['tenantId', 'createdAt']);
    });

    it('declares countryCode column with a length constraint (driven by migration)', () => {
        const cc = columns.find((c) => c.propertyName === 'countryCode');
        expect(cc?.options.length).toBeDefined();
    });
});
