import 'reflect-metadata';

/**
 * Module wiring for Organization invitations.
 *
 * What this guards is the failure `tsc` cannot see: a provider that is
 * imported and type-checked but never registered. Nest resolves that at BOOT,
 * not at compile time, so the symptom is every API pod crash-looping on
 * `Nest can't resolve dependencies of the OrganizationInvitationsController`
 * — after the image is built, pushed and rolled.
 *
 * It also pins the constructor shape of the flow service. A `design:paramtypes`
 * entry that comes back `undefined` is the signature of a circular import,
 * which likewise compiles cleanly and dies at boot.
 *
 * Mocking posture mirrors `ingest.module.spec.ts`: stub the heavy workspace
 * barrels at module scope so the decorator metadata can be read without
 * dragging the entity/generator graph through Jest's CJS transformer. The
 * mocked classes are only identity anchors — the assertions are about which
 * collaborators are requested and in what order, not about their behaviour.
 */

jest.mock('@ever-works/agent/services', () => ({
    OrganizationInvitationService: class OrganizationInvitationService {},
}));
jest.mock('@ever-works/agent/database', () => ({
    OrganizationMemberRepository: class OrganizationMemberRepository {},
    OrganizationRepository: class OrganizationRepository {},
    TenantRepository: class TenantRepository {},
    UserRepository: class UserRepository {},
}));
jest.mock('@ever-works/agent/entities', () => ({}));
jest.mock('../../scope/tenant-bootstrap.service', () => ({
    TenantBootstrapService: class TenantBootstrapService {},
}));
jest.mock('../organization-membership.service', () => ({
    OrganizationMembershipService: class OrganizationMembershipService {},
}));

import { OrganizationInvitationFlowService } from '../organization-invitation-flow.service';

const EXPECTED_COLLABORATORS = [
    'OrganizationInvitationService',
    'OrganizationMemberRepository',
    'OrganizationRepository',
    'UserRepository',
    'TenantRepository',
    'TenantBootstrapService',
    'OrganizationMembershipService',
];

describe('Organization invitations — module wiring', () => {
    const paramtypes = (): Array<{ name?: string } | undefined> =>
        Reflect.getMetadata('design:paramtypes', OrganizationInvitationFlowService) ?? [];

    it('every constructor dependency resolves to a real class', () => {
        const params = paramtypes();
        expect(params.length).toBe(EXPECTED_COLLABORATORS.length);

        for (const param of params) {
            // `undefined` here means a circular import, not a missing
            // provider: TypeScript emits the metadata as undefined when the
            // type is not yet defined at decoration time, and Nest then fails
            // at boot with an unhelpful "dependency at index [n]" message.
            expect(param).toBeDefined();
            expect(typeof param).toBe('function');
        }
    });

    it('asks for exactly the collaborators it needs, in order', () => {
        // Order matters: Nest injects positionally, so a reordered constructor
        // that still type-checks would hand the UserRepository to the slot
        // expecting the OrganizationRepository.
        expect(paramtypes().map((p) => p?.name)).toEqual(EXPECTED_COLLABORATORS);
    });

    it('depends on TenantBootstrapService — the audited tenantId writer', () => {
        // Pinned explicitly because the temptation, when this grows, is to
        // write users.tenantId directly from the flow service. Every write to
        // that column has to stay in TenantBootstrapService, where the
        // never-move-a-user refusal lives.
        expect(paramtypes().map((p) => p?.name)).toContain('TenantBootstrapService');
    });
});
