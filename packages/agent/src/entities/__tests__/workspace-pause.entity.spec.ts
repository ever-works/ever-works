import { getMetadataArgsStorage } from 'typeorm';
import { WORKSPACE_PAUSE_REASON_MAX } from '@ever-works/contracts';
import { WorkspacePause } from '../workspace-pause.entity';

describe('WorkspacePause entity', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((entry) => entry.target === WorkspacePause);
    const column = (name: string) => columns.find((entry) => entry.propertyName === name);
    const indices = storage.indices.filter((entry) => entry.target === WorkspacePause);

    it('maps to workspace_pauses', () => {
        const table = storage.tables.find((entry) => entry.target === WorkspacePause);
        expect(table?.name).toBe('workspace_pauses');
    });

    it('declares NO decorator-level unique index on the workspace pair', () => {
        // The constraint is a Postgres PARTIAL unique pair, hand-written in the
        // migration exactly as `work_budgets` does it: a workspace is
        // (tenantId, organizationId) with a NULL organization for the
        // bare-tenant case, and SQL treats NULLs as DISTINCT inside a unique
        // index. A decorator index would ALSO make TypeORM generate a
        // non-partial duplicate on the better-sqlite3 test driver.
        expect(indices.filter((entry) => entry.unique)).toHaveLength(0);
        const pairIndex = indices.find(
            (entry) =>
                Array.isArray(entry.columns) &&
                (entry.columns as string[]).includes('tenantId') &&
                (entry.columns as string[]).includes('organizationId'),
        );
        expect(pairIndex).toBeUndefined();
    });

    it('still indexes the two lookups the pause is read through', () => {
        expect(indices.map((entry) => entry.name).sort()).toEqual([
            'idx_workspace_pauses_tenant',
            'idx_workspace_pauses_user',
        ]);
    });

    it('anchors every pause to a tenant and allows a bare-tenant workspace', () => {
        expect(column('tenantId')?.options.nullable).toBeFalsy();
        expect(column('organizationId')?.options.nullable).toBe(true);
    });

    it('records the person who paused, and never allows that to be absent', () => {
        // FR-47: only a person in an interactive session may pause or resume.
        expect(column('pausedByUserId')?.options.nullable).toBeFalsy();
    });

    it('caps the reason at the published limit and lets it be absent', () => {
        expect(column('reason')?.options.length).toBe(WORKSPACE_PAUSE_REASON_MAX);
        expect(column('reason')?.options.nullable).toBe(true);
    });

    it('starts both counters at zero so a fresh pause reports honestly', () => {
        expect(column('refusedStarts')?.options.default).toBe(0);
        expect(column('cleanlyStopped')?.options.default).toBe(0);
    });

    it('uses a driver-portable date column for pausedAt', () => {
        // A raw `type: 'timestamp'` fails better-sqlite3's metadata validation
        // at BOOT, which takes the whole API down rather than one query. The
        // reflected `Date` lets TypeORM pick each dialect's own type.
        expect(column('pausedAt')?.options.type).toBe(Date);
    });

    it('carries no relation decorator', () => {
        expect(storage.relations.filter((entry) => entry.target === WorkspacePause)).toHaveLength(
            0,
        );
    });
});
