jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    INVITATION_ROLE_OWNER_CLAIM: 'owner-claim',
    WorkInvitationStatus: {
        PENDING: 'pending',
        ACCEPTED: 'accepted',
        EXPIRED: 'expired',
        REVOKED: 'revoked',
    },
}));
jest.mock('../auth', () => ({
    AuthService: class {},
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));
jest.mock('../config/constants', () => ({
    config: { webAppUrl: jest.fn(() => 'https://app.example.com') },
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InvitationsController } from './invitations.controller';
import { WorkInvitationIssuedEvent } from '../events';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { WorkInvitationService, WorkOwnershipService } from '@ever-works/agent/services';
import type { AuthService } from '../auth';
import type { EventEmitter2 } from '@nestjs/event-emitter';

describe('InvitationsController', () => {
    const auth: AuthenticatedUser = { userId: 'auth-1' } as any;
    const inviter = { id: 'user-1', username: 'inviter@example.com', email: 'inviter@example.com' };
    const work = { id: 'w-1', name: 'Awesome Go', userId: 'user-1' };

    let invitations: {
        issue: jest.Mock;
        listPending: jest.Mock;
        revoke: jest.Mock;
    };
    let ownership: {
        ensureIsOwner: jest.Mock;
        ensureCanManageMembers: jest.Mock;
    };
    let authService: { getUser: jest.Mock };
    let eventEmitter: { emit: jest.Mock };
    let controller: InvitationsController;

    beforeEach(() => {
        invitations = {
            issue: jest.fn().mockResolvedValue({
                invitation: {
                    id: 'inv-1',
                    workId: 'w-1',
                    role: 'manager',
                    email: 'a@example.com',
                    status: 'pending',
                    tokenExpiresAt: new Date('2099-01-01'),
                    createdAt: new Date('2026-01-01'),
                    invitedById: 'user-1',
                    metadata: null,
                },
                token: 'a'.repeat(64),
            }),
            listPending: jest.fn().mockResolvedValue([]),
            revoke: jest.fn().mockResolvedValue(undefined),
        };
        ownership = {
            ensureIsOwner: jest.fn().mockResolvedValue({ work }),
            ensureCanManageMembers: jest.fn().mockResolvedValue({ work }),
        };
        authService = { getUser: jest.fn().mockResolvedValue(inviter) };
        eventEmitter = { emit: jest.fn() };

        controller = new InvitationsController(
            invitations as unknown as WorkInvitationService,
            ownership as unknown as WorkOwnershipService,
            authService as unknown as AuthService,
            eventEmitter as unknown as EventEmitter2,
        );
    });

    afterEach(() => jest.restoreAllMocks());

    describe('create', () => {
        it('issues a member invitation, returns claimUrl, emits event', async () => {
            const result = await controller.create(auth, 'w-1', {
                email: 'a@example.com',
                role: 'manager',
            } as any);

            expect(ownership.ensureCanManageMembers).toHaveBeenCalledWith('w-1', 'user-1');
            expect(ownership.ensureIsOwner).not.toHaveBeenCalled();
            expect(invitations.issue).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: 'w-1',
                    invitedById: 'user-1',
                    role: 'manager',
                    email: 'a@example.com',
                }),
            );
            expect(result.claimUrl).toMatch(/^https:\/\/app\.example\.com\/claim\/[0-9a-f]{64}$/);
            expect(eventEmitter.emit).toHaveBeenCalledWith(
                WorkInvitationIssuedEvent.EVENT_NAME,
                expect.any(WorkInvitationIssuedEvent),
            );
        });

        it('owner-claim path requires Owner role and expectedProviderUsername', async () => {
            await controller.create(auth, 'w-1', {
                role: 'owner-claim',
                expectedProviderUsername: 'avelino',
            } as any);

            expect(ownership.ensureIsOwner).toHaveBeenCalledWith('w-1', 'user-1');
            expect(invitations.issue).toHaveBeenCalledWith(
                expect.objectContaining({
                    role: 'owner-claim',
                    metadata: expect.objectContaining({ expectedProviderUsername: 'avelino' }),
                }),
            );
        });

        it('rejects owner-claim without expectedProviderUsername (neither field nor metadata)', async () => {
            await expect(
                controller.create(auth, 'w-1', { role: 'owner-claim' } as any),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(invitations.issue).not.toHaveBeenCalled();
        });

        it('accepts expectedProviderUsername via metadata bag', async () => {
            await controller.create(auth, 'w-1', {
                role: 'owner-claim',
                metadata: { expectedProviderUsername: 'foo' },
            } as any);

            expect(invitations.issue).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: expect.objectContaining({ expectedProviderUsername: 'foo' }),
                }),
            );
        });

        it('rejects member-role invitations without an email', async () => {
            await expect(
                controller.create(auth, 'w-1', { role: 'editor' } as any),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(invitations.issue).not.toHaveBeenCalled();
        });

        it('propagates ownership-check failures (non-owner trying owner-claim)', async () => {
            ownership.ensureIsOwner.mockRejectedValue(new Error('forbidden'));
            await expect(
                controller.create(auth, 'w-1', {
                    role: 'owner-claim',
                    expectedProviderUsername: 'a',
                } as any),
            ).rejects.toThrow('forbidden');
            expect(invitations.issue).not.toHaveBeenCalled();
        });

        it('event payload carries expectedProviderUsername=null for non-claim invites', async () => {
            await controller.create(auth, 'w-1', {
                email: 'a@example.com',
                role: 'viewer',
            } as any);

            const emitted = eventEmitter.emit.mock.calls[0][1] as WorkInvitationIssuedEvent;
            expect(emitted.expectedProviderUsername).toBeNull();
            expect(emitted.recipientEmail).toBe('a@example.com');
        });
    });

    describe('list', () => {
        it('returns pending invitations after manager check', async () => {
            invitations.listPending.mockResolvedValue([
                {
                    id: 'inv-1',
                    workId: 'w-1',
                    role: 'manager',
                    email: 'a@example.com',
                    status: 'pending',
                    tokenExpiresAt: new Date('2099-01-01'),
                    createdAt: new Date('2026-01-01'),
                    invitedById: 'user-1',
                    metadata: null,
                },
            ]);
            const result = await controller.list(auth, 'w-1');
            expect(ownership.ensureCanManageMembers).toHaveBeenCalledWith('w-1', 'user-1');
            expect(result.status).toBe('success');
            expect(result.invitations).toHaveLength(1);
            expect(result.invitations[0]).not.toHaveProperty('claimUrl');
        });

        it('never returns claimUrl for listed (already-persisted) invitations', async () => {
            invitations.listPending.mockResolvedValue([
                {
                    id: 'inv-1',
                    workId: 'w-1',
                    role: 'manager',
                    email: null,
                    status: 'pending',
                    tokenExpiresAt: new Date(),
                    createdAt: new Date(),
                    invitedById: 'user-1',
                    metadata: null,
                },
            ]);
            const result = await controller.list(auth, 'w-1');
            for (const inv of result.invitations) {
                expect(inv.claimUrl).toBeUndefined();
            }
        });
    });

    describe('revoke', () => {
        it('forwards to service when invitation exists in pending list', async () => {
            invitations.listPending.mockResolvedValue([{ id: 'inv-1' }]);
            const result = await controller.revoke(auth, 'w-1', 'inv-1');
            expect(ownership.ensureCanManageMembers).toHaveBeenCalledWith('w-1', 'user-1');
            expect(invitations.revoke).toHaveBeenCalledWith('inv-1', 'user-1');
            expect(result).toEqual({ status: 'success' });
        });

        it('returns 404 if no pending invitation matches the id (cross-tenant guard)', async () => {
            invitations.listPending.mockResolvedValue([{ id: 'other' }]);
            await expect(controller.revoke(auth, 'w-1', 'inv-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(invitations.revoke).not.toHaveBeenCalled();
        });
    });
});
