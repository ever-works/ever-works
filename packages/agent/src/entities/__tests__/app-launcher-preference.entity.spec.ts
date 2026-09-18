import { getMetadataArgsStorage } from 'typeorm';
import { AppLauncherPreference } from '../app-launcher-preference.entity';
import { Work } from '../work.entity';

/**
 * APW-11 T2 — the entity's shape, pinned against the migration (T3) so the two
 * cannot drift apart unnoticed.
 *
 * Spec FR-24/FR-25/FR-27/FR-28 (`spec.md:285-295`); plan §3.2
 * (`plan.md:205-237`) is the normative column list; `data-model.md` §2.11 the
 * programme's own table.
 *
 * What matters here, in the order the task states it: the index and unique
 * **names** the migration also creates, the **absence** of the two scope-stamp
 * columns the plan deliberately omits, and the **defaults** a fresh row starts
 * with. The Work column's default — `NULL`, i.e. "no explicit choice" — is
 * asserted here at metadata level and again, against real rows, in
 * `apps/api/src/migrations/__tests__/CreateAppLauncherPreferences.spec.ts`.
 */
describe('AppLauncherPreference entity', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((column) => column.target === AppLauncherPreference);
    const column = (name: string) => columns.find((entry) => entry.propertyName === name);

    it('maps to app_launcher_preferences', () => {
        const table = storage.tables.find((entry) => entry.target === AppLauncherPreference);
        expect(table?.name).toBe('app_launcher_preferences');
    });

    it('declares the unique constraint the migration creates, under the same name', () => {
        const unique = storage.uniques.filter((entry) => entry.target === AppLauncherPreference);

        expect(unique).toHaveLength(1);
        expect(unique[0].name).toBe('uq_app_launcher_prefs_user_scope_item');
        expect(unique[0].columns).toEqual(['userId', 'scopeKey', 'itemKey']);
    });

    it('declares the read index the migration creates, under the same name', () => {
        const indices = storage.indices.filter((entry) => entry.target === AppLauncherPreference);

        expect(indices).toHaveLength(1);
        expect(indices[0].name).toBe('idx_app_launcher_prefs_user_scope');
        expect(indices[0].columns).toEqual(['userId', 'scopeKey']);
        // The uniqueness above is a CONSTRAINT, not a second index: one row per
        // (person, scope, item) and one index on the read path.
        expect(indices[0].unique).not.toBe(true);
    });

    it('declares neither a tenantId nor an organizationId column', () => {
        // Plan §3.2:227-229 — the scope-stamping subscriber would write the
        // ACTIVE Organization onto a 'global' Ever-app row every Organization
        // shares. `scopeKey` carries the scope instead, and access is by
        // `userId` alone (FR-53).
        const propertyNames = columns.map((entry) => entry.propertyName);

        expect(propertyNames).not.toContain('tenantId');
        expect(propertyNames).not.toContain('organizationId');
        expect(
            storage.relations.filter((entry) => entry.target === AppLauncherPreference),
        ).toHaveLength(1);
    });

    it('starts a fresh row shown and not pinned', () => {
        expect(column('visible')?.options.type).toBe('boolean');
        expect(column('visible')?.options.default).toBe(true);
        expect(column('pinned')?.options.type).toBe('boolean');
        expect(column('pinned')?.options.default).toBe(false);
    });

    it('declares the nullable order columns with the widths the plan gives them', () => {
        expect(column('pinOrder')?.options.type).toBe('smallint');
        expect(column('pinOrder')?.options.nullable).toBe(true);
        expect(column('sortOrder')?.options.type).toBe('integer');
        expect(column('sortOrder')?.options.nullable).toBe(true);
    });

    it('declares the scope key and the item key NOT NULL at the documented widths', () => {
        expect(column('scopeKey')?.options.type).toBe('varchar');
        expect(column('scopeKey')?.options.length).toBe(40);
        expect(column('scopeKey')?.options.nullable).not.toBe(true);

        expect(column('itemKey')?.options.type).toBe('varchar');
        expect(column('itemKey')?.options.length).toBe(64);
        expect(column('itemKey')?.options.nullable).not.toBe(true);
    });

    it('cascades on the account, because the arrangement belongs to the person', () => {
        expect(column('userId')?.options.type).toBe('uuid');
        expect(column('userId')?.options.nullable).not.toBe(true);

        const [relation] = storage.relations.filter(
            (entry) => entry.target === AppLauncherPreference && entry.propertyName === 'user',
        );
        expect(relation?.relationType).toBe('many-to-one');
        expect(relation?.options.onDelete).toBe('CASCADE');
    });

    it("carries createdAt and updatedAt — updatedAt is FR-62's pin-time tie-break", () => {
        // TypeORM records @CreateDateColumn / @UpdateDateColumn in the
        // `columns` storage with a `mode`, not in a separate registry.
        const createdAt = storage.columns.find(
            (entry) => entry.target === AppLauncherPreference && entry.propertyName === 'createdAt',
        );
        const updatedAt = storage.columns.find(
            (entry) => entry.target === AppLauncherPreference && entry.propertyName === 'updatedAt',
        );

        expect(createdAt?.mode).toBe('createDate');
        expect(updatedAt?.mode).toBe('updateDate');
    });
});

describe('Work.appLauncherExposed', () => {
    const storage = getMetadataArgsStorage();
    const columns = storage.columns.filter((column) => column.target === Work);

    it('is one appended nullable boolean with NO default', () => {
        const exposed = columns.find((column) => column.propertyName === 'appLauncherExposed');

        expect(exposed).toBeDefined();
        expect(exposed?.options.type).toBe('boolean');
        expect(exposed?.options.nullable).toBe(true);
        // No `default` is the whole point (spec FR-19): `NULL` means "follow this
        // Work kind's default", which is a third state a `DEFAULT false` or
        // `DEFAULT true` would collapse into a choice nobody made. A default here
        // would also imply a backfill the migration deliberately does not run.
        expect(exposed?.options.default).toBeUndefined();
    });

    it('leaves every other Work column exactly as it was', () => {
        // The additive-only rule (CONTRACTS R-26) in one assertion: this change
        // adds a column and removes nothing.
        const propertyNames = columns.map((entry) => entry.propertyName);

        for (const existing of [
            'id',
            'userId',
            'name',
            'slug',
            'kind',
            'status',
            'managedSubdomain',
            'organizationId',
            'createdAt',
            'updatedAt',
        ]) {
            expect(propertyNames).toContain(existing);
        }
    });
});
