import { DataSource } from 'typeorm';
import { ENTITIES } from '@ever-works/agent/database';
import { Organization, OrganizationMember, User } from '@ever-works/agent/entities';
import { EverIdClaimHintsService, type EverIdOrgLinkReader } from './ever-id-claims-hints';

/**
 * APW-12 (Ever ID) — the optional `urn:ever:` organization hints in a verified
 * ID token: they preselect a landing Organization the person already belongs
 * to, honour `orgs_filtered`, never create anything, and the company-sign-in
 * check stays dormant until a link reader is bound.
 */
const TENANT = '99999999-9999-4999-8999-999999999999';
const OWNED_ORG = 'aaaaaaaa-0000-4000-8000-000000000001';
const MEMBER_ORG = 'aaaaaaaa-0000-4000-8000-000000000002';
const FOREIGN_ORG = 'aaaaaaaa-0000-4000-8000-000000000003';
const USER = '11111111-1111-4111-8111-111111111111';

describe('EverIdClaimHintsService', () => {
    let dataSource: DataSource;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
        });
        await dataSource.initialize();
        await dataSource.query('PRAGMA foreign_keys = OFF');
        await dataSource.getRepository(User).insert({
            id: USER,
            username: 'person',
            slug: 'person',
            email: 'person@example.com',
            tenantId: TENANT,
        } as never);
        await dataSource.getRepository(Organization).insert([
            { id: OWNED_ORG, displayName: 'Owned', slug: 'owned', tenantId: TENANT },
            { id: MEMBER_ORG, displayName: 'Member', slug: 'member', tenantId: 'other-tenant' },
            { id: FOREIGN_ORG, displayName: 'Foreign', slug: 'foreign', tenantId: 'other-tenant' },
        ] as never);
        await dataSource.getRepository(OrganizationMember).insert({
            organizationId: MEMBER_ORG,
            tenantId: 'other-tenant',
            userId: USER,
            role: 'member',
            joinedAt: new Date(),
        } as never);
    });
    afterAll(async () => dataSource.destroy());

    const hints = (orgs: unknown, filtered: unknown = [], extra: Record<string, unknown> = {}) => ({
        'urn:ever:claims_ver': 1,
        'urn:ever:orgs': orgs,
        'urn:ever:orgs_filtered': filtered,
        ...extra,
    });
    const org = (id: string, productOrgId: string) => ({
        id,
        links: [{ product_org_id: productOrgId }],
    });

    it('preselects an Organization the person owns through their Tenant', async () => {
        const service = new EverIdClaimHintsService(dataSource);
        await expect(service.evaluate(USER, hints([org('e1', OWNED_ORG)]))).resolves.toEqual({
            preselectedOrganizationId: OWNED_ORG,
            refused: false,
        });
    });

    it('preselects an Organization the person is a member of, skipping one they do not belong to', async () => {
        const service = new EverIdClaimHintsService(dataSource);
        await expect(
            service.evaluate(USER, hints([org('e0', FOREIGN_ORG), org('e1', MEMBER_ORG)])),
        ).resolves.toEqual({ preselectedOrganizationId: MEMBER_ORG, refused: false });
    });

    it('honours orgs_filtered', async () => {
        const service = new EverIdClaimHintsService(dataSource);
        await expect(
            service.evaluate(
                USER,
                hints([org('e1', OWNED_ORG)], [{ id: 'e1', reason: 'mfa_required' }]),
            ),
        ).resolves.toEqual({ preselectedOrganizationId: null, refused: false });
    });

    it.each([
        ['no hints', undefined],
        [
            'an unknown claims version',
            { 'urn:ever:claims_ver': 2, 'urn:ever:orgs': [org('e1', OWNED_ORG)] },
        ],
        ['malformed orgs', hints('not-an-array')],
        ['a non-uuid link', hints([org('e1', 'org_123')])],
    ])('ignores %s and proceeds', async (_label, value) => {
        const service = new EverIdClaimHintsService(dataSource);
        await expect(service.evaluate(USER, value as never)).resolves.toEqual({
            preselectedOrganizationId: null,
            refused: false,
        });
    });

    it('writes only the landing scope and never creates an Organization or a membership', async () => {
        const service = new EverIdClaimHintsService(dataSource);
        const before = {
            orgs: await dataSource.getRepository(Organization).count(),
            members: await dataSource.getRepository(OrganizationMember).count(),
        };

        await service.applyPreselection(USER, OWNED_ORG);

        expect(
            (await dataSource.getRepository(User).findOne({ where: { id: USER } }))
                ?.lastScopeOrganizationId,
        ).toBe(OWNED_ORG);
        expect({
            orgs: await dataSource.getRepository(Organization).count(),
            members: await dataSource.getRepository(OrganizationMember).count(),
        }).toEqual(before);
    });

    describe('company sign-in (dormant until a link reader is bound)', () => {
        const required: EverIdOrgLinkReader = {
            findForOrganization: async () => ({
                everOrgId: 'ever-org-x',
                companySignInRequired: true,
            }),
        };

        it('refuses a personal identity when the linked Ever organization requires its company identity', async () => {
            const service = new EverIdClaimHintsService(dataSource, required);
            await expect(
                service.evaluate(USER, hints([org('ever-org-x', OWNED_ORG)])),
            ).resolves.toEqual({
                preselectedOrganizationId: null,
                refused: true,
            });
        });

        it('admits the matching company identity', async () => {
            const service = new EverIdClaimHintsService(dataSource, required);
            await expect(
                service.evaluate(
                    USER,
                    hints([org('ever-org-x', OWNED_ORG)], [], {
                        'urn:ever:identity_kind': 'enterprise',
                        'urn:ever:enterprise_org_id': 'ever-org-x',
                    }),
                ),
            ).resolves.toEqual({ preselectedOrganizationId: OWNED_ORG, refused: false });
        });

        it('never refuses without a bound reader', async () => {
            const service = new EverIdClaimHintsService(dataSource);
            await expect(
                service.evaluate(USER, hints([org('ever-org-x', OWNED_ORG)])),
            ).resolves.toMatchObject({
                refused: false,
            });
        });
    });
});
