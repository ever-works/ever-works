import {
    BadRequestException,
    ConflictException,
    ForbiddenException,
    NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { QueryFailedError } from 'typeorm';
import { OrganizationInvitationService } from '../organization-invitation.service';
import { OrganizationInvitationStatus } from '../../entities/types';
import type { OrganizationInvitation } from '../../entities/organization-invitation.entity';

/**
 * Organization invitations — the token lifecycle.
 *
 * The properties worth pinning are the ones whose failure is silent: a token
 * that is stored in the clear, an invitation that two people can both redeem,
 * and the email binding that distinguishes this from the Work flow.
 */

type RepoMock = {
    create: jest.Mock;
    findById: jest.Mock;
    findByTokenHash: jest.Mock;
    findPendingForEmail: jest.Mock;
    listForOrganization: jest.Mock;
    listPendingForOrganization: jest.Mock;
    tryMarkAccepted: jest.Mock;
    markRevoked: jest.Mock;
    expireBefore: jest.Mock;
    expireStaleForEmail: jest.Mock;
    findExpiredPending: jest.Mock;
};

function repoMock(): RepoMock {
    return {
        create: jest.fn(async (x: object) => ({ id: 'inv-new', ...x })),
        findById: jest.fn().mockResolvedValue(null),
        findByTokenHash: jest.fn().mockResolvedValue(null),
        findPendingForEmail: jest.fn().mockResolvedValue(null),
        listForOrganization: jest.fn().mockResolvedValue([]),
        listPendingForOrganization: jest.fn().mockResolvedValue([]),
        tryMarkAccepted: jest.fn().mockResolvedValue(true),
        markRevoked: jest.fn().mockResolvedValue(true),
        expireBefore: jest.fn().mockResolvedValue(0),
        expireStaleForEmail: jest.fn().mockResolvedValue(0),
        findExpiredPending: jest.fn().mockResolvedValue([]),
    };
}

function build() {
    const repo = repoMock();
    const service = new OrganizationInvitationService(repo as never);
    return { service, repo };
}

const BASE_INPUT = {
    organizationId: 'org-1',
    tenantId: 'ten-1',
    invitedById: 'u-1',
    email: 'newcomer@example.com',
};

function makeInvitation(overrides: Partial<OrganizationInvitation> = {}): OrganizationInvitation {
    const inv = {
        id: 'inv-1',
        organizationId: 'org-1',
        tenantId: 'ten-1',
        email: 'Newcomer@Example.com',
        emailNormalized: 'newcomer@example.com',
        role: 'member',
        tokenHash: 'hash',
        tokenExpiresAt: new Date(Date.now() + 86_400_000),
        invitedById: 'u-1',
        status: OrganizationInvitationStatus.PENDING,
        acceptedByUserId: null,
        acceptedAt: null,
        metadata: null,
        isExpired(now: Date = new Date()) {
            return this.tokenExpiresAt.getTime() <= now.getTime();
        },
        ...overrides,
    } as unknown as OrganizationInvitation;
    return inv;
}

describe('OrganizationInvitationService', () => {
    describe('issue', () => {
        it('persists ONLY the hash and returns the raw token once', async () => {
            // The single most important property here. If the raw token were
            // ever written, read access to the table would be equivalent to
            // holding every outstanding invitation.
            const { service, repo } = build();
            const { token, invitation } = await service.issue(BASE_INPUT);

            const persisted = repo.create.mock.calls[0][0];
            expect(persisted.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
            expect(JSON.stringify(persisted)).not.toContain(token);
            expect(token).toHaveLength(64); // 32 bytes, hex
            expect(invitation.id).toBe('inv-new');
        });

        it('stores the address as typed AND a normalised copy', async () => {
            const { service, repo } = build();
            await service.issue({ ...BASE_INPUT, email: '  Newcomer@Example.COM  ' });

            const persisted = repo.create.mock.calls[0][0];
            // As typed (trimmed) — this is what the email is addressed to.
            expect(persisted.email).toBe('Newcomer@Example.COM');
            // Canonical — this is what uniqueness and accept compare on.
            expect(persisted.emailNormalized).toBe('newcomer@example.com');
        });

        it('maps the unique-index violation to 409, not a raw 500', async () => {
            // Two clicks a millisecond apart both pass any read-then-write
            // check, so the partial unique index is the real authority and its
            // error has to be translated. A real QueryFailedError with SQLSTATE
            // 23505 — a hand-rolled { code } slips past the guard.
            const { service, repo } = build();
            // The driver error is the THIRD constructor argument and is where
            // isUniqueConstraintError looks — setting .code on the wrapper
            // instead sails straight past the guard, which is exactly the
            // mistake this comment exists to stop the next person repeating.
            const driverError = Object.assign(new Error('duplicate key value'), {
                code: '23505',
            });
            const dup = new QueryFailedError('INSERT', [], driverError as never);
            repo.create.mockRejectedValue(dup);

            await expect(service.issue(BASE_INPUT)).rejects.toThrow(ConflictException);
        });

        it('retires an aged-out invitation so the address can be re-invited', async () => {
            // The partial unique index is WHERE status = 'pending', and nothing
            // moves a row to `expired` on a timer. Without this sweep an
            // invitation nobody accepted in time holds the slot forever and
            // re-inviting that person fails with `invitation_already_pending` —
            // naming a live invitation whose token is dead, with no UI to
            // revoke it because it still looks pending.
            const { service, repo } = build();

            await service.issue(BASE_INPUT);

            expect(repo.expireStaleForEmail).toHaveBeenCalledWith('org-1', 'newcomer@example.com');
            // And it happens BEFORE the insert, or the index rejects us first.
            const sweepOrder = repo.expireStaleForEmail.mock.invocationCallOrder[0];
            const createOrder = repo.create.mock.invocationCallOrder[0];
            expect(sweepOrder).toBeLessThan(createOrder);
        });

        it('rejects a malformed address before minting anything', async () => {
            const { service, repo } = build();
            await expect(service.issue({ ...BASE_INPUT, email: 'not-an-email' })).rejects.toThrow(
                BadRequestException,
            );
            await expect(service.issue({ ...BASE_INPUT, email: '   ' })).rejects.toThrow(
                BadRequestException,
            );
            expect(repo.create).not.toHaveBeenCalled();
        });

        it('clamps the expiry window instead of trusting the caller', async () => {
            const { service } = build();
            await expect(service.issue({ ...BASE_INPUT, expiresInDays: 0 })).rejects.toThrow(
                BadRequestException,
            );
            await expect(service.issue({ ...BASE_INPUT, expiresInDays: 3650 })).rejects.toThrow(
                BadRequestException,
            );
            await expect(service.issue({ ...BASE_INPUT, expiresInDays: NaN })).rejects.toThrow(
                BadRequestException,
            );
        });

        it('defaults to a 7-day window', async () => {
            const { service, repo } = build();
            const before = Date.now();
            await service.issue(BASE_INPUT);
            const { tokenExpiresAt } = repo.create.mock.calls[0][0];
            const days = (tokenExpiresAt.getTime() - before) / 86_400_000;
            expect(days).toBeGreaterThan(6.9);
            expect(days).toBeLessThan(7.1);
        });

        it('two invitations never share a token', async () => {
            const { service } = build();
            const a = await service.issue(BASE_INPUT);
            const b = await service.issue(BASE_INPUT);
            expect(a.token).not.toBe(b.token);
        });
    });

    describe('findConsumable', () => {
        it('looks up by HASH — the raw token never reaches a query', async () => {
            const { service, repo } = build();
            repo.findByTokenHash.mockResolvedValue(makeInvitation());
            const token = 'a'.repeat(64);

            await service.findConsumable(token);

            expect(repo.findByTokenHash).toHaveBeenCalledWith(
                createHash('sha256').update(token).digest('hex'),
            );
            expect(repo.findByTokenHash).not.toHaveBeenCalledWith(token);
        });

        it('distinguishes revoked, already-accepted, expired and unknown', async () => {
            const { service, repo } = build();

            repo.findByTokenHash.mockResolvedValue(null);
            await expect(service.findConsumable('t')).rejects.toThrow(NotFoundException);

            repo.findByTokenHash.mockResolvedValue(
                makeInvitation({ status: OrganizationInvitationStatus.REVOKED }),
            );
            await expect(service.findConsumable('t')).rejects.toThrow(ForbiddenException);

            repo.findByTokenHash.mockResolvedValue(
                makeInvitation({ status: OrganizationInvitationStatus.ACCEPTED }),
            );
            await expect(service.findConsumable('t')).rejects.toThrow(BadRequestException);

            repo.findByTokenHash.mockResolvedValue(
                makeInvitation({ tokenExpiresAt: new Date(Date.now() - 1000) }),
            );
            await expect(service.findConsumable('t')).rejects.toThrow(BadRequestException);
        });

        it('judges expiry by the CLOCK, not by status', async () => {
            // Nothing sweeps pending rows on a timer, so a row sits at
            // `pending` long past its expiry. Reading status alone would
            // happily admit a token that died a month ago.
            const { service, repo } = build();
            repo.findByTokenHash.mockResolvedValue(
                makeInvitation({
                    status: OrganizationInvitationStatus.PENDING,
                    tokenExpiresAt: new Date(Date.now() - 30 * 86_400_000),
                }),
            );
            await expect(service.findConsumable('t')).rejects.toThrow(/invitation_expired/);
        });
    });

    describe('the email binding — the deliberate divergence from Work invitations', () => {
        it('refuses a redeemer whose address is not the invited one', async () => {
            // Accepting writes users.tenantId, which grants access to EVERY
            // Organization in that Tenant. A forwarded email must not be
            // enough; the Work token is a bearer credential, this one is not.
            const { service, repo } = build();
            repo.findByTokenHash.mockResolvedValue(makeInvitation());

            await expect(service.findConsumable('t', 'someone.else@example.com')).rejects.toThrow(
                ForbiddenException,
            );
        });

        it('accepts the invited address regardless of case or padding', async () => {
            const { service, repo } = build();
            repo.findByTokenHash.mockResolvedValue(makeInvitation());

            await expect(
                service.findConsumable('t', '  NEWCOMER@example.com '),
            ).resolves.toBeDefined();
        });

        it('skips the binding ONLY when no address is supplied (the preview path)', async () => {
            // The signed-out landing page renders "you've been invited to
            // Acme" before the visitor has an account. That path grants
            // nothing, so it is allowed to resolve without an address.
            const { service, repo } = build();
            repo.findByTokenHash.mockResolvedValue(makeInvitation());

            await expect(service.findConsumable('t')).resolves.toBeDefined();
        });

        it('does not treat a prefix as a match', async () => {
            const { service, repo } = build();
            repo.findByTokenHash.mockResolvedValue(makeInvitation());
            await expect(service.findConsumable('t', 'newcomer@example.co')).rejects.toThrow(
                ForbiddenException,
            );
        });
    });

    describe('tryAccept', () => {
        it('delegates to the conditional UPDATE and reports the loser', async () => {
            // Two people redeeming one token must not both succeed: one
            // membership, one tenant write. The repository resolves the race
            // in the database; the service must propagate the false.
            const { service, repo } = build();
            repo.tryMarkAccepted.mockResolvedValue(false);
            await expect(service.tryAccept('inv-1', 'u-2')).resolves.toBe(false);

            repo.tryMarkAccepted.mockResolvedValue(true);
            await expect(service.tryAccept('inv-1', 'u-2')).resolves.toBe(true);
        });
    });

    describe('revoke', () => {
        it('404s an invitation belonging to a different Organization', async () => {
            // Pinning the id to the org in the URL, so a member of org A
            // cannot cancel org B's invitation by guessing an id. 404 rather
            // than 403 so it is not a probe either.
            const { service, repo } = build();
            repo.findById.mockResolvedValue(makeInvitation({ organizationId: 'org-OTHER' }));

            await expect(service.revoke('org-1', 'inv-1')).rejects.toThrow(NotFoundException);
            expect(repo.markRevoked).not.toHaveBeenCalled();
        });

        it('refuses to revoke anything that is not pending', async () => {
            const { service, repo } = build();
            repo.findById.mockResolvedValue(
                makeInvitation({ status: OrganizationInvitationStatus.ACCEPTED }),
            );
            await expect(service.revoke('org-1', 'inv-1')).rejects.toThrow(BadRequestException);
        });

        it('surfaces a lost race rather than reporting success', async () => {
            const { service, repo } = build();
            repo.findById.mockResolvedValue(makeInvitation());
            repo.markRevoked.mockResolvedValue(false); // accepted in between
            await expect(service.revoke('org-1', 'inv-1')).rejects.toThrow(
                /invitation_state_changed/,
            );
        });
    });

    describe('normaliseEmail', () => {
        it('case-folds and trims but does NOT strip dots or plus tags', () => {
            // Dot-stripping and plus-tag removal are Gmail conventions, not
            // SMTP ones. Applying them would make a.b@corp.com and ab@corp.com
            // the same person on a domain where they are two employees.
            expect(OrganizationInvitationService.normaliseEmail('  A.B+tag@Corp.COM ')).toBe(
                'a.b+tag@corp.com',
            );
        });
    });
});
