import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { WorkInvitationService } from '../work-invitation.service';
import { WorkInvitationRepository } from '../../database/repositories/work-invitation.repository';
import { WorkInvitation } from '../../entities/work-invitation.entity';
import { WorkInvitationStatus, INVITATION_ROLE_OWNER_CLAIM } from '../../entities/types';

type RepoMock = jest.Mocked<WorkInvitationRepository>;

function sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
}

function buildRepoMock(): RepoMock {
    return {
        create: jest.fn(),
        findById: jest.fn(),
        findByTokenHash: jest.fn(),
        listPendingForWork: jest.fn(),
        tryMarkAccepted: jest.fn(),
        markRevoked: jest.fn(),
        updateTransferState: jest.fn(),
        expireBefore: jest.fn(),
        findExpiredPending: jest.fn(),
    } as unknown as RepoMock;
}

function makeInvitation(overrides: Partial<WorkInvitation> = {}): WorkInvitation {
    const inv = new WorkInvitation();
    inv.id = 'inv-1';
    inv.workId = 'work-1';
    inv.email = null;
    inv.role = 'manager';
    inv.tokenHash = sha256('seed');
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

describe('WorkInvitationService', () => {
    let repo: RepoMock;
    let service: WorkInvitationService;

    beforeEach(() => {
        repo = buildRepoMock();
        service = new WorkInvitationService(repo);
    });

    describe('issue', () => {
        it('persists invitation with hashed token and returns raw token once', async () => {
            repo.create.mockImplementation(async (data) =>
                makeInvitation(data as Partial<WorkInvitation>),
            );

            const { invitation, token } = await service.issue({
                workId: 'w1',
                invitedById: 'u1',
                role: 'manager',
                email: 'a@example.com',
            });

            expect(token).toMatch(/^[0-9a-f]{64}$/);
            expect(invitation.tokenHash).toBe(sha256(token));
            expect(repo.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: 'w1',
                    invitedById: 'u1',
                    role: 'manager',
                    email: 'a@example.com',
                    status: WorkInvitationStatus.PENDING,
                }),
            );
            const arg = repo.create.mock.calls[0][0] as Partial<WorkInvitation>;
            expect(arg.tokenHash).toBe(sha256(token));
            expect(arg.tokenExpiresAt).toBeInstanceOf(Date);
        });

        it('defaults expiry to 30 days', async () => {
            repo.create.mockImplementation(async (d) =>
                makeInvitation(d as Partial<WorkInvitation>),
            );
            const before = Date.now();
            await service.issue({ workId: 'w1', invitedById: 'u1', role: 'viewer' });
            const arg = repo.create.mock.calls[0][0] as Partial<WorkInvitation>;
            const elapsed = (arg.tokenExpiresAt as Date).getTime() - before;
            const thirtyDays = 30 * 24 * 60 * 60 * 1000;
            expect(elapsed).toBeGreaterThanOrEqual(thirtyDays - 1000);
            expect(elapsed).toBeLessThanOrEqual(thirtyDays + 1000);
        });

        it('rejects non-integer or non-positive expiry', async () => {
            await expect(
                service.issue({
                    workId: 'w1',
                    invitedById: 'u1',
                    role: 'viewer',
                    expiresInDays: 0,
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                service.issue({
                    workId: 'w1',
                    invitedById: 'u1',
                    role: 'viewer',
                    expiresInDays: 1.5,
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('caps expiry at 90 days', async () => {
            await expect(
                service.issue({
                    workId: 'w1',
                    invitedById: 'u1',
                    role: 'viewer',
                    expiresInDays: 91,
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects unknown role', async () => {
            await expect(
                service.issue({ workId: 'w1', invitedById: 'u1', role: 'admin' as never }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('requires expectedProviderUsername for owner-claim', async () => {
            await expect(
                service.issue({
                    workId: 'w1',
                    invitedById: 'u1',
                    role: INVITATION_ROLE_OWNER_CLAIM,
                }),
            ).rejects.toBeInstanceOf(BadRequestException);

            await expect(
                service.issue({
                    workId: 'w1',
                    invitedById: 'u1',
                    role: INVITATION_ROLE_OWNER_CLAIM,
                    metadata: { expectedProviderUsername: '   ' },
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('seeds transferState=not_required for owner-claim', async () => {
            repo.create.mockImplementation(async (d) =>
                makeInvitation(d as Partial<WorkInvitation>),
            );
            await service.issue({
                workId: 'w1',
                invitedById: 'u1',
                role: INVITATION_ROLE_OWNER_CLAIM,
                metadata: { expectedProviderUsername: 'avelino' },
            });
            const arg = repo.create.mock.calls[0][0] as Partial<WorkInvitation>;
            expect(arg.transferState).toEqual({ status: 'not_required' });
        });

        it('leaves transferState null for regular invitations', async () => {
            repo.create.mockImplementation(async (d) =>
                makeInvitation(d as Partial<WorkInvitation>),
            );
            await service.issue({ workId: 'w1', invitedById: 'u1', role: 'editor' });
            const arg = repo.create.mock.calls[0][0] as Partial<WorkInvitation>;
            expect(arg.transferState).toBeNull();
        });

        it('issues different tokens across calls', async () => {
            repo.create.mockImplementation(async (d) =>
                makeInvitation(d as Partial<WorkInvitation>),
            );
            const a = await service.issue({ workId: 'w1', invitedById: 'u1', role: 'viewer' });
            const b = await service.issue({ workId: 'w1', invitedById: 'u1', role: 'viewer' });
            expect(a.token).not.toBe(b.token);
        });
    });

    describe('findConsumable', () => {
        it('returns the invitation for a valid pending token', async () => {
            const token = 'a'.repeat(64);
            const inv = makeInvitation({ tokenHash: sha256(token) });
            repo.findByTokenHash.mockResolvedValue(inv);

            const result = await service.findConsumable(token);
            expect(result).toBe(inv);
            expect(repo.findByTokenHash).toHaveBeenCalledWith(sha256(token));
        });

        it('throws BadRequest for missing token', async () => {
            await expect(service.findConsumable('')).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                service.findConsumable(undefined as unknown as string),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('throws NotFound when no row matches', async () => {
            repo.findByTokenHash.mockResolvedValue(null);
            await expect(service.findConsumable('a'.repeat(64))).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('throws Forbidden when revoked', async () => {
            repo.findByTokenHash.mockResolvedValue(
                makeInvitation({ status: WorkInvitationStatus.REVOKED }),
            );
            await expect(service.findConsumable('a'.repeat(64))).rejects.toBeInstanceOf(
                ForbiddenException,
            );
        });

        it('throws BadRequest when already accepted', async () => {
            repo.findByTokenHash.mockResolvedValue(
                makeInvitation({ status: WorkInvitationStatus.ACCEPTED }),
            );
            await expect(service.findConsumable('a'.repeat(64))).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('throws BadRequest when expired and sweeps', async () => {
            repo.findByTokenHash.mockResolvedValue(
                makeInvitation({ tokenExpiresAt: new Date(Date.now() - 1000) }),
            );
            repo.expireBefore.mockResolvedValue(1);
            await expect(service.findConsumable('a'.repeat(64))).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(repo.expireBefore).toHaveBeenCalled();
        });
    });

    describe('revoke', () => {
        it('marks pending as revoked', async () => {
            repo.findById.mockResolvedValue(makeInvitation());
            repo.markRevoked.mockResolvedValue(true);
            await expect(service.revoke('inv-1', 'user-1')).resolves.toBeUndefined();
            expect(repo.markRevoked).toHaveBeenCalledWith('inv-1');
        });

        it('throws NotFound when missing', async () => {
            repo.findById.mockResolvedValue(null);
            await expect(service.revoke('missing', 'user-1')).rejects.toBeInstanceOf(
                NotFoundException,
            );
        });

        it('rejects non-pending invitations', async () => {
            repo.findById.mockResolvedValue(
                makeInvitation({ status: WorkInvitationStatus.ACCEPTED }),
            );
            await expect(service.revoke('inv-1', 'user-1')).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('surfaces CAS loss', async () => {
            repo.findById.mockResolvedValue(makeInvitation());
            repo.markRevoked.mockResolvedValue(false);
            await expect(service.revoke('inv-1', 'user-1')).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });
    });

    describe('tryAccept', () => {
        it('delegates to repository CAS and returns its result', async () => {
            repo.tryMarkAccepted.mockResolvedValue(true);
            const result = await service.tryAccept('inv-1', 'user-2');
            expect(result).toBe(true);
            expect(repo.tryMarkAccepted).toHaveBeenCalledWith('inv-1', 'user-2', expect.any(Date));
        });
    });

    describe('verifyToken', () => {
        it('matches a token to its hash via constant-time compare', () => {
            const token = 'b'.repeat(64);
            const ok = service.verifyToken(token, sha256(token));
            expect(ok).toBe(true);
        });

        it('rejects mismatched token', () => {
            const ok = service.verifyToken('b'.repeat(64), sha256('c'.repeat(64)));
            expect(ok).toBe(false);
        });

        it('rejects on length mismatch without crashing', () => {
            expect(service.verifyToken('short', sha256('anything'))).toBe(false);
        });
    });

    describe('sweepExpired', () => {
        it('forwards to repository.expireBefore', async () => {
            repo.expireBefore.mockResolvedValue(7);
            const n = await service.sweepExpired();
            expect(n).toBe(7);
            expect(repo.expireBefore).toHaveBeenCalled();
        });
    });
});
