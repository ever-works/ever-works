jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/facades', () => ({}));
jest.mock('@ever-works/agent/entities', () => ({
    INVITATION_ROLE_OWNER_CLAIM: 'owner-claim',
    WorkMemberRole: {
        OWNER: 'owner',
        MANAGER: 'manager',
        EDITOR: 'editor',
        VIEWER: 'viewer',
    },
}));
jest.mock('../auth', () => ({
    AuthService: class {},
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));
jest.mock('../auth/decorators/public.decorator', () => ({
    Public: () => () => undefined,
}));

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ClaimController } from './claim.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { WorkInvitationService } from '@ever-works/agent/services';
import type {
    AuthAccountRepository,
    WorkMemberRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import type { GitFacadeService } from '@ever-works/agent/facades';
import type { AuthService } from '../auth';

const TOKEN = 'a'.repeat(64);

function makeInvitation(over: Record<string, unknown> = {}): any {
    return {
        id: 'inv-1',
        workId: 'w-1',
        role: 'manager',
        email: 'a@example.com',
        tokenExpiresAt: new Date('2099-01-01'),
        invitedById: 'user-1',
        status: 'pending',
        metadata: null,
        ...over,
    };
}

describe('ClaimController', () => {
    const auth: AuthenticatedUser = { userId: 'auth-2' } as any;
    const claimant = { id: 'user-2', username: 'avelino' };

    let invitations: {
        findConsumable: jest.Mock;
        tryAccept: jest.Mock;
        setTransferState: jest.Mock;
    };
    let workRepo: { findById: jest.Mock };
    let memberRepo: { findMember: jest.Mock; addMember: jest.Mock };
    let authAccountRepo: { findProviderAccountsByUserId: jest.Mock };
    let authService: { getUser: jest.Mock };
    let gitFacade: { transferRepository: jest.Mock };
    let controller: ClaimController;

    beforeEach(() => {
        invitations = {
            findConsumable: jest.fn(),
            tryAccept: jest.fn().mockResolvedValue(true),
            setTransferState: jest.fn().mockResolvedValue(undefined),
        };
        workRepo = {
            findById: jest.fn().mockResolvedValue({
                id: 'w-1',
                name: 'Awesome Go',
                userId: 'user-1',
                gitProvider: 'github',
                owner: 'ever-works',
                slug: 'awesome-go',
            }),
        };
        memberRepo = {
            findMember: jest.fn().mockResolvedValue(null),
            addMember: jest.fn().mockResolvedValue(undefined),
        };
        authAccountRepo = { findProviderAccountsByUserId: jest.fn().mockResolvedValue([]) };
        authService = { getUser: jest.fn().mockResolvedValue(claimant) };
        gitFacade = {
            transferRepository: jest.fn().mockResolvedValue({
                status: 'pending_recipient_acceptance',
                providerAcceptanceUrl: 'https://github.com/avelino',
            }),
        };

        controller = new ClaimController(
            invitations as unknown as WorkInvitationService,
            workRepo as unknown as WorkRepository,
            memberRepo as unknown as WorkMemberRepository,
            authAccountRepo as unknown as AuthAccountRepository,
            authService as unknown as AuthService,
            gitFacade as unknown as GitFacadeService,
        );
    });

    afterEach(() => jest.restoreAllMocks());

    describe('preview', () => {
        it('returns work info without consuming the token', async () => {
            invitations.findConsumable.mockResolvedValue(
                makeInvitation({ metadata: { expectedProviderUsername: 'avelino' } }),
            );

            const result = await controller.preview(TOKEN);

            expect(invitations.findConsumable).toHaveBeenCalledWith(TOKEN);
            expect(invitations.tryAccept).not.toHaveBeenCalled();
            expect(result.workName).toBe('Awesome Go');
            expect(result.role).toBe('manager');
            expect(result.expectedProviderUsername).toBe('avelino');
        });

        it('returns null expectedProviderUsername when metadata is empty', async () => {
            invitations.findConsumable.mockResolvedValue(makeInvitation());
            const result = await controller.preview(TOKEN);
            expect(result.expectedProviderUsername).toBeNull();
        });

        it('throws BadRequest when the underlying work disappeared', async () => {
            invitations.findConsumable.mockResolvedValue(makeInvitation());
            workRepo.findById.mockResolvedValue(null);
            await expect(controller.preview(TOKEN)).rejects.toBeInstanceOf(BadRequestException);
        });

        it('treats null token as empty string for the service call', async () => {
            invitations.findConsumable.mockResolvedValue(makeInvitation());
            await controller.preview(undefined as unknown as string);
            expect(invitations.findConsumable).toHaveBeenCalledWith('');
        });
    });

    describe('accept — member role', () => {
        beforeEach(() => {
            invitations.findConsumable.mockResolvedValue(makeInvitation({ role: 'manager' }));
        });

        it('creates a WorkMember row and returns transferStatus=not_required', async () => {
            const result = await controller.accept(auth, { token: TOKEN });
            expect(invitations.tryAccept).toHaveBeenCalledWith('inv-1', 'user-2');
            expect(memberRepo.addMember).toHaveBeenCalledWith('w-1', 'user-2', 'manager', 'user-1');
            expect(result).toEqual({
                invitationId: 'inv-1',
                workId: 'w-1',
                role: 'manager',
                transferStatus: 'not_required',
            });
        });

        it('rejects when claimant is already the work owner', async () => {
            workRepo.findById.mockResolvedValue({ id: 'w-1', userId: 'user-2', name: 'X' });
            await expect(controller.accept(auth, { token: TOKEN })).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(memberRepo.addMember).not.toHaveBeenCalled();
        });

        it('rejects when the claimant is already a member', async () => {
            memberRepo.findMember.mockResolvedValue({ id: 'm-99' });
            await expect(controller.accept(auth, { token: TOKEN })).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(invitations.tryAccept).not.toHaveBeenCalled();
        });

        it('rejects when CAS-accept fails (someone else beat us)', async () => {
            invitations.tryAccept.mockResolvedValue(false);
            await expect(controller.accept(auth, { token: TOKEN })).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(memberRepo.addMember).not.toHaveBeenCalled();
        });

        it('rejects unknown role', async () => {
            invitations.findConsumable.mockResolvedValue(
                makeInvitation({ role: 'unknown-role' as never }),
            );
            await expect(controller.accept(auth, { token: TOKEN })).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });
    });

    describe('accept — owner-claim', () => {
        beforeEach(() => {
            invitations.findConsumable.mockResolvedValue(
                makeInvitation({
                    role: 'owner-claim',
                    metadata: { expectedProviderUsername: 'avelino' },
                }),
            );
        });

        it('accepts, calls gitFacade for each repo, returns acceptance URL', async () => {
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                { providerId: 'github', username: 'avelino' },
            ]);

            const result = await controller.accept(auth, { token: TOKEN });

            expect(invitations.tryAccept).toHaveBeenCalledWith('inv-1', 'user-2');
            expect(gitFacade.transferRepository).toHaveBeenCalledTimes(2);
            expect(gitFacade.transferRepository).toHaveBeenNthCalledWith(
                1,
                'ever-works',
                'awesome-go-data',
                { newOwner: 'avelino' },
                { providerId: 'github', userId: 'user-1' },
            );
            expect(gitFacade.transferRepository).toHaveBeenNthCalledWith(
                2,
                'ever-works',
                'awesome-go-website',
                { newOwner: 'avelino' },
                { providerId: 'github', userId: 'user-1' },
            );
            expect(invitations.setTransferState).toHaveBeenCalledWith(
                'inv-1',
                expect.objectContaining({
                    status: 'pending_recipient_acceptance',
                    repoTransfers: expect.arrayContaining([
                        expect.objectContaining({
                            repo: 'awesome-go-data',
                            status: 'pending_recipient_acceptance',
                        }),
                        expect.objectContaining({
                            repo: 'awesome-go-website',
                            status: 'pending_recipient_acceptance',
                        }),
                    ]),
                }),
            );
            expect(memberRepo.addMember).not.toHaveBeenCalled();
            expect(result).toEqual({
                invitationId: 'inv-1',
                workId: 'w-1',
                role: 'owner-claim',
                transferStatus: 'pending_recipient_acceptance',
                providerAcceptanceUrl: 'https://github.com/avelino',
            });
        });

        it('reports status=completed when every plugin call returns completed', async () => {
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                { providerId: 'github', username: 'avelino' },
            ]);
            gitFacade.transferRepository.mockResolvedValue({ status: 'completed' });

            const result = await controller.accept(auth, { token: TOKEN });
            expect(result.transferStatus).toBe('completed');
        });

        it('reports status=failed when every repo call throws (e.g., 404 / no permission)', async () => {
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                { providerId: 'github', username: 'avelino' },
            ]);
            gitFacade.transferRepository.mockRejectedValue(new Error('Not Found'));

            const result = await controller.accept(auth, { token: TOKEN });
            expect(result.transferStatus).toBe('failed');
            expect(invitations.setTransferState).toHaveBeenCalledWith(
                'inv-1',
                expect.objectContaining({
                    status: 'failed',
                    repoTransfers: [
                        expect.objectContaining({ repo: 'awesome-go-data', status: 'failed' }),
                        expect.objectContaining({ repo: 'awesome-go-website', status: 'failed' }),
                    ],
                }),
            );
        });

        it('falls back to pending without repoTransfers when work.owner is missing (operator-assisted)', async () => {
            workRepo.findById.mockResolvedValue({
                id: 'w-1',
                name: 'Awesome Go',
                userId: 'user-1',
                gitProvider: 'github',
                slug: 'awesome-go',
                // no owner
            });
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                { providerId: 'github', username: 'avelino' },
            ]);

            const result = await controller.accept(auth, { token: TOKEN });
            expect(gitFacade.transferRepository).not.toHaveBeenCalled();
            expect(result.transferStatus).toBe('pending_recipient_acceptance');
        });

        it('treats GitFacadeError (e.g., plugin lacks transferRepository) as failure but still records claim', async () => {
            workRepo.findById.mockResolvedValue({
                id: 'w-1',
                name: 'X',
                userId: 'user-1',
                gitProvider: 'gitlab',
                slug: 'awesome-go',
                owner: 'ever-works',
            });
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                { providerId: 'gitlab', username: 'avelino' },
            ]);
            gitFacade.transferRepository.mockRejectedValue(
                new Error('Transfer repository not supported by this provider'),
            );

            const result = await controller.accept(auth, { token: TOKEN });
            expect(invitations.tryAccept).toHaveBeenCalled();
            expect(result.transferStatus).toBe('failed');
        });

        it('matches case-insensitively and trims whitespace', async () => {
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                { providerId: 'github', username: '  Avelino  ' },
            ]);
            await expect(controller.accept(auth, { token: TOKEN })).resolves.toBeDefined();
        });

        it('rejects when no connected provider account matches the expected login', async () => {
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                { providerId: 'github', username: 'someone-else' },
            ]);
            await expect(controller.accept(auth, { token: TOKEN })).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            expect(invitations.tryAccept).not.toHaveBeenCalled();
        });

        it('only considers accounts whose providerId matches work.gitProvider when set', async () => {
            // GitHub user has bitbucket account with matching name → ignored.
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                { providerId: 'bitbucket', username: 'avelino' },
            ]);
            await expect(controller.accept(auth, { token: TOKEN })).rejects.toBeInstanceOf(
                ForbiddenException,
            );
        });

        it('matches across providers if work.gitProvider is null (multi-provider fallback)', async () => {
            workRepo.findById.mockResolvedValue({
                id: 'w-1',
                name: 'X',
                userId: 'user-1',
                gitProvider: undefined,
            });
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                { providerId: 'gitlab', username: 'avelino' },
            ]);
            await expect(controller.accept(auth, { token: TOKEN })).resolves.toBeDefined();
        });

        it('rejects when expectedProviderUsername is missing from metadata', async () => {
            invitations.findConsumable.mockResolvedValue(
                makeInvitation({ role: 'owner-claim', metadata: null }),
            );
            await expect(controller.accept(auth, { token: TOKEN })).rejects.toBeInstanceOf(
                BadRequestException,
            );
        });

        it('rejects when CAS-accept fails', async () => {
            authAccountRepo.findProviderAccountsByUserId.mockResolvedValue([
                { providerId: 'github', username: 'avelino' },
            ]);
            invitations.tryAccept.mockResolvedValue(false);
            await expect(controller.accept(auth, { token: TOKEN })).rejects.toBeInstanceOf(
                BadRequestException,
            );
            expect(invitations.setTransferState).not.toHaveBeenCalled();
        });
    });
});
