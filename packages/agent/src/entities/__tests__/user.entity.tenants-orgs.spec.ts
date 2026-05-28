import { getMetadataArgsStorage } from 'typeorm';
import { User } from '../user.entity';

/**
 * EW-654 (Tenants & Organizations Phase 2) — shape tests for the
 * User entity's new scope FKs.
 *
 * Scoped to Phase 2 additions only (`tenantId`, `lastScopeOrganizationId`).
 * The rest of the User entity has no dedicated spec — see the broader
 * agent-level coverage in `database/repositories/__tests__/user.repository.spec.ts`
 * for behavioural assertions. This file exists narrowly to lock in the
 * Phase 2 contract before Phase 6 starts writing to these columns.
 */
describe('User entity — Phase 2 scope columns', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((c) => c.target === User);
    const relations = storage.relations.filter((r) => r.target === User);

    it('declares `tenantId` as a nullable uuid column', () => {
        const col = columns.find((c) => c.propertyName === 'tenantId');
        expect(col).toBeDefined();
        expect(col?.options.type).toBe('uuid');
        expect(col?.options.nullable).toBe(true);
    });

    it('declares `lastScopeOrganizationId` as a nullable uuid column', () => {
        const col = columns.find((c) => c.propertyName === 'lastScopeOrganizationId');
        expect(col).toBeDefined();
        expect(col?.options.type).toBe('uuid');
        expect(col?.options.nullable).toBe(true);
    });

    it('declares the `tenant` ManyToOne relation with ON DELETE SET NULL', () => {
        const rel = relations.find((r) => r.propertyName === 'tenant');
        expect(rel).toBeDefined();
        expect(rel?.relationType).toBe('many-to-one');
        expect(rel?.options.nullable).toBe(true);
        expect(rel?.options.onDelete).toBe('SET NULL');
    });

    it('declares the `lastScopeOrganization` ManyToOne relation with ON DELETE SET NULL', () => {
        const rel = relations.find((r) => r.propertyName === 'lastScopeOrganization');
        expect(rel).toBeDefined();
        expect(rel?.relationType).toBe('many-to-one');
        expect(rel?.options.nullable).toBe(true);
        expect(rel?.options.onDelete).toBe('SET NULL');
    });
});
