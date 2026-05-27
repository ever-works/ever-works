import { getMetadataArgsStorage } from 'typeorm';
import { AuthAccount } from '../auth-account.entity';
import { AuthSession } from '../auth-session.entity';
import { AuthVerification } from '../auth-verification.entity';
import { RefreshToken } from '../refresh-token.entity';
import { UserTaskCounter } from '../user-task-counter.entity';
import { UserTemplatePreference } from '../user-template-preference.entity';

/**
 * EW-654 (Tenants & Organizations Phase 2) — Tier B `tenantId`
 * column drift detector.
 *
 * Locks in the per-tier rule from [spec.md §2.3](../../../../../docs/specs/features/tenants-and-organizations/spec.md#23-three-tiers-of-entities-which-columns-each-tier-gets):
 *
 *   - Every Tier B entity has a nullable `tenantId` uuid column.
 *   - **No Tier B entity has `organizationId`** — that's the
 *     defining distinction from Tier A (auth records are
 *     user-identity, not Org-scoped). Future code that wrongly
 *     adds `organizationId` to a Tier B entity (e.g. trying to be
 *     "consistent") trips this spec immediately.
 */
describe('Tier B entities — Phase 2 tenantId column', () => {
    const storage = getMetadataArgsStorage();

    const tierB = [
        { name: 'AuthAccount', target: AuthAccount },
        { name: 'AuthSession', target: AuthSession },
        { name: 'AuthVerification', target: AuthVerification },
        { name: 'RefreshToken', target: RefreshToken },
        { name: 'UserTaskCounter', target: UserTaskCounter },
        { name: 'UserTemplatePreference', target: UserTemplatePreference },
    ];

    for (const { name, target } of tierB) {
        describe(name, () => {
            const columns = storage.columns.filter((c) => c.target === target);

            it('declares a nullable `tenantId` uuid column', () => {
                const col = columns.find((c) => c.propertyName === 'tenantId');
                expect(col).toBeDefined();
                expect(col?.options.type).toBe('uuid');
                expect(col?.options.nullable).toBe(true);
            });

            it('does NOT declare an `organizationId` column (Tier B is Org-irrelevant)', () => {
                const col = columns.find((c) => c.propertyName === 'organizationId');
                expect(col).toBeUndefined();
            });
        });
    }
});
