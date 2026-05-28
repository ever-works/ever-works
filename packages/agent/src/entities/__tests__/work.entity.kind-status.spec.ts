import { getMetadataArgsStorage } from 'typeorm';
import { Work } from '../work.entity';

/**
 * EW-665 (Tenants & Organizations Phase 13) — shape tests for the new
 * `Work.kind` + `Work.status` lifecycle columns. The DB-level defaults +
 * backfill are covered by the migration test in apps/api; this asserts
 * the entity metadata matches the migration (varchar(32), NOT NULL,
 * defaults `'default'` / `'active'`).
 */
describe('Work entity — kind + status (EW-665 Phase 13)', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((c) => c.target === Work);

    it('declares the `kind` column: varchar(32), default "default"', () => {
        const kind = columns.find((c) => c.propertyName === 'kind');
        expect(kind).toBeDefined();
        expect(kind?.options.type).toBe('varchar');
        expect(kind?.options.length).toBe(32);
        expect(kind?.options.default).toBe('default');
        // NOT NULL — never explicitly marked nullable.
        expect(kind?.options.nullable).not.toBe(true);
    });

    it('declares the `status` column: varchar(32), default "active"', () => {
        const status = columns.find((c) => c.propertyName === 'status');
        expect(status).toBeDefined();
        expect(status?.options.type).toBe('varchar');
        expect(status?.options.length).toBe(32);
        expect(status?.options.default).toBe('active');
        expect(status?.options.nullable).not.toBe(true);
    });
});
