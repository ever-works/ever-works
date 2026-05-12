import { WorkInvitation } from '../work-invitation.entity';
import { WorkInvitationStatus } from '../types';

function make(overrides: Partial<WorkInvitation> = {}): WorkInvitation {
    const inv = new WorkInvitation();
    inv.id = 'inv-1';
    inv.workId = 'work-1';
    inv.email = null;
    inv.role = 'manager';
    inv.tokenHash = 'a'.repeat(64);
    inv.tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    inv.invitedById = 'user-1';
    inv.status = WorkInvitationStatus.PENDING;
    inv.acceptedByUserId = null;
    inv.acceptedAt = null;
    inv.transferState = null;
    inv.metadata = null;
    inv.createdAt = new Date();
    inv.updatedAt = new Date();
    Object.assign(inv, overrides);
    return inv;
}

describe('WorkInvitation entity', () => {
    describe('isExpired', () => {
        it('returns false for future expiry', () => {
            expect(make().isExpired()).toBe(false);
        });

        it('returns true once expiry is reached', () => {
            const inv = make({ tokenExpiresAt: new Date(Date.now() - 1000) });
            expect(inv.isExpired()).toBe(true);
        });

        it('treats expiry == now as expired', () => {
            const fixed = new Date('2026-01-01T00:00:00Z');
            const inv = make({ tokenExpiresAt: fixed });
            expect(inv.isExpired(fixed)).toBe(true);
        });
    });

    describe('isConsumable', () => {
        it('is consumable when pending and not expired', () => {
            expect(make().isConsumable()).toBe(true);
        });

        it('not consumable when accepted', () => {
            expect(make({ status: WorkInvitationStatus.ACCEPTED }).isConsumable()).toBe(false);
        });

        it('not consumable when revoked', () => {
            expect(make({ status: WorkInvitationStatus.REVOKED }).isConsumable()).toBe(false);
        });

        it('not consumable when expired', () => {
            const inv = make({ tokenExpiresAt: new Date(Date.now() - 1000) });
            expect(inv.isConsumable()).toBe(false);
        });
    });
});
