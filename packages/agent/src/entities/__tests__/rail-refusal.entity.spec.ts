import { getMetadataArgsStorage } from 'typeorm';
import { RAIL_REFUSAL_SUMMARY_MAX } from '@ever-works/contracts';
import { RailRefusal } from '../rail-refusal.entity';

describe('RailRefusal entity', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((entry) => entry.target === RailRefusal);
    const column = (name: string) => columns.find((entry) => entry.propertyName === name);
    const indices = storage.indices.filter((entry) => entry.target === RailRefusal);

    it('maps to rail_refusals', () => {
        const table = storage.tables.find((entry) => entry.target === RailRefusal);
        expect(table?.name).toBe('rail_refusals');
    });

    it('declares the four indexes the log is read through', () => {
        expect(indices.map((entry) => entry.name).sort()).toEqual([
            'idx_rail_refusals_agent_category',
            'idx_rail_refusals_collapse',
            'idx_rail_refusals_rail',
            'idx_rail_refusals_user_created',
        ]);
    });

    it('declares no unique index — the table is append-only', () => {
        expect(indices.filter((entry) => entry.unique)).toHaveLength(0);
    });

    it('caps the summary at the published limit', () => {
        // FR-70: a refusal row may never carry a body, a credential or a
        // command's arguments — only enough to identify what was stopped.
        expect(column('summary')?.options.length).toBe(RAIL_REFUSAL_SUMMARY_MAX);
        expect(column('summary')?.options.nullable).toBeFalsy();
    });

    it('stores the identifying parameters as portable JSON, and allows none', () => {
        expect(column('requested')?.options.type).toBe('simple-json');
        expect(column('requested')?.options.nullable).toBe(true);
        expect(column('ceiling')?.options.type).toBe('simple-json');
        expect(column('ceiling')?.options.nullable).toBe(true);
    });

    it('allows a null category only because an unclassified action has none', () => {
        expect(column('category')?.options.nullable).toBe(true);
    });

    it('requires the rail, the verdict and the reason on every row', () => {
        for (const name of ['railId', 'verdict', 'reasonCode', 'subjectType', 'collapseKey']) {
            expect(column(name)?.options.nullable).toBeFalsy();
        }
    });

    it('carries a createdAt and no updatedAt — rows are immutable once written', () => {
        const created = columns.find((entry) => entry.propertyName === 'createdAt');
        expect(created?.mode).toBe('createDate');
        expect(columns.find((entry) => entry.propertyName === 'updatedAt')).toBeUndefined();
    });

    it('declares both scope columns and no relation decorator', () => {
        expect(column('tenantId')?.options.nullable).toBe(true);
        expect(column('organizationId')?.options.nullable).toBe(true);
        expect(storage.relations.filter((entry) => entry.target === RailRefusal)).toHaveLength(0);
    });
});
