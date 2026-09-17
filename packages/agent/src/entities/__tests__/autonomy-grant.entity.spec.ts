import { getMetadataArgsStorage } from 'typeorm';
import { AutonomyGrant } from '../autonomy-grant.entity';

describe('AutonomyGrant entity', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((entry) => entry.target === AutonomyGrant);
    const column = (name: string) => columns.find((entry) => entry.propertyName === name);
    const indices = storage.indices.filter((entry) => entry.target === AutonomyGrant);

    it('maps to autonomy_grants', () => {
        const table = storage.tables.find((entry) => entry.target === AutonomyGrant);
        expect(table?.name).toBe('autonomy_grants');
    });

    it('stores one rung per (owner, scope, category)', () => {
        // Without this, a concurrent double-write could leave two rows that
        // disagree about what an Agent may do, and the resolver would pick one
        // at read order.
        const unique = indices.filter((entry) => entry.unique).map((entry) => entry.columns);
        expect(unique).toEqual([['userId', 'scopeType', 'scopeId', 'category']]);
        expect(indices.find((entry) => entry.unique)?.name).toBe(
            'uq_autonomy_grants_owner_scope_category',
        );
    });

    it('indexes the scope lookup the resolver actually performs', () => {
        const names = indices.map((entry) => entry.name).sort();
        expect(names).toEqual([
            'idx_autonomy_grants_scope',
            'idx_autonomy_grants_user',
            'uq_autonomy_grants_owner_scope_category',
        ]);
    });

    it('never makes a unique-index member nullable', () => {
        // SQL treats NULLs as DISTINCT inside a unique index, so a nullable
        // member would let a burst of same-scope creates all succeed.
        for (const name of ['userId', 'scopeType', 'scopeId', 'category']) {
            expect(column(name)?.options.nullable).toBeFalsy();
        }
    });

    it('records who wrote the rung, and never allows that to be absent', () => {
        // FR-31: a rung may only ever be changed by a person in an interactive
        // session. This column is the record of which person.
        expect(column('setByUserId')?.options.type).toBe('uuid');
        expect(column('setByUserId')?.options.nullable).toBeFalsy();
    });

    it('caps the note at 500 characters and lets it be absent', () => {
        expect(column('note')?.options.length).toBe(500);
        expect(column('note')?.options.nullable).toBe(true);
    });

    it('declares both scope columns so the stamping subscriber fills them', () => {
        // `ScopeStampingSubscriber` keys on an entity declaring BOTH columns.
        expect(column('tenantId')?.options.nullable).toBe(true);
        expect(column('organizationId')?.options.nullable).toBe(true);
    });

    it('carries no relation decorator', () => {
        // EW-654 entity-cycle rule: the foreign keys live in the migration.
        const relations = storage.relations.filter((entry) => entry.target === AutonomyGrant);
        expect(relations).toHaveLength(0);
    });

    it('uses driver-portable date columns', () => {
        // better-sqlite3 has no `timestamp` type and rejects the metadata at
        // BOOT, which takes every e2e shard down in global-setup.
        const created = storage.columns.find(
            (entry) => entry.target === AutonomyGrant && entry.propertyName === 'createdAt',
        );
        const updated = storage.columns.find(
            (entry) => entry.target === AutonomyGrant && entry.propertyName === 'updatedAt',
        );
        expect(created?.mode).toBe('createDate');
        expect(updated?.mode).toBe('updateDate');
    });
});
