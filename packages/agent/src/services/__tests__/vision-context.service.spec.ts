import { VisionContextService } from '../vision-context.service';

/**
 * PR-6 (Vision) — unit contract for `VisionContextService.resolveForUser`.
 *
 * Resolution rule (review §23.5): a user's "active" org is
 * `users.lastScopeOrganizationId`; when that is NULL (or the user/org row
 * is missing, or the org has no vision) there is NO vision context and the
 * service resolves to `null`. When set, the vision text is returned
 * trimmed and capped at 2000 characters so prompt injection stays bounded.
 */
describe('VisionContextService', () => {
    let userRepository: { findOne: jest.Mock };
    let organizationRepository: { findOne: jest.Mock };
    let service: VisionContextService;

    beforeEach(() => {
        userRepository = { findOne: jest.fn() };
        organizationRepository = { findOne: jest.fn() };
        service = new VisionContextService(userRepository as any, organizationRepository as any);
    });

    const stubUser = (lastScopeOrganizationId: string | null) => {
        userRepository.findOne.mockResolvedValue({ id: 'u-1', lastScopeOrganizationId });
    };

    describe('resolveForUser', () => {
        it('returns null when the user row does not exist', async () => {
            userRepository.findOne.mockResolvedValue(null);

            await expect(service.resolveForUser('missing-user')).resolves.toBeNull();
            expect(organizationRepository.findOne).not.toHaveBeenCalled();
        });

        it('returns null when the user has no active org (lastScopeOrganizationId NULL)', async () => {
            stubUser(null);

            await expect(service.resolveForUser('u-1')).resolves.toBeNull();
            // No active org id → there is nothing to look up.
            expect(organizationRepository.findOne).not.toHaveBeenCalled();
        });

        it('returns null when the active organization row is missing', async () => {
            stubUser('org-1');
            organizationRepository.findOne.mockResolvedValue(null);

            await expect(service.resolveForUser('u-1')).resolves.toBeNull();
        });

        it('returns null when the active organization has no vision set', async () => {
            stubUser('org-1');
            organizationRepository.findOne.mockResolvedValue({ id: 'org-1', vision: null });

            await expect(service.resolveForUser('u-1')).resolves.toBeNull();
        });

        it('returns the trimmed vision text when the active organization has one', async () => {
            stubUser('org-1');
            organizationRepository.findOne.mockResolvedValue({
                id: 'org-1',
                vision: '  Build the calmest way to run a company.  ',
            });

            await expect(service.resolveForUser('u-1')).resolves.toBe(
                'Build the calmest way to run a company.',
            );
            expect(organizationRepository.findOne).toHaveBeenCalledTimes(1);
        });

        it('caps vision text at 2000 characters (prompt token-budget guard)', async () => {
            stubUser('org-1');
            organizationRepository.findOne.mockResolvedValue({
                id: 'org-1',
                vision: 'v'.repeat(2500),
            });

            await expect(service.resolveForUser('u-1')).resolves.toBe('v'.repeat(2000));
        });
    });
});
