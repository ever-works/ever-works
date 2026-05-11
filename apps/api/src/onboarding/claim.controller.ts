import {
    BadRequestException,
    Body,
    Controller,
    ForbiddenException,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { WorkInvitationService } from '@ever-works/agent/services';
import {
    AuthAccountRepository,
    WorkMemberRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import {
    INVITATION_ROLE_OWNER_CLAIM,
    WorkInvitation,
    WorkInvitationTransferState,
    WorkMemberRole,
} from '@ever-works/agent/entities';
import { Public } from '../auth/decorators/public.decorator';
import { AuthService, AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import {
    ClaimAcceptDto,
    ClaimAcceptResponseDto,
    ClaimPreviewResponseDto,
} from './dto/claim.dto';

@ApiTags('Claim')
@Controller('api/claim')
export class ClaimController {
    constructor(
        private readonly invitations: WorkInvitationService,
        private readonly workRepository: WorkRepository,
        private readonly memberRepository: WorkMemberRepository,
        private readonly authAccountRepository: AuthAccountRepository,
        private readonly authService: AuthService,
    ) {}

    @Public()
    @Get('preview')
    @HttpCode(HttpStatus.OK)
    @Throttle({ default: { limit: 30, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Preview a claim invitation without consuming it',
        description:
            'Returns enough metadata for the claim landing page. Throws 400 if the token is expired/already-accepted, 403 if revoked, 404 if unknown.',
    })
    @ApiResponse({ status: 200, type: ClaimPreviewResponseDto })
    async preview(@Query('token') token: string): Promise<ClaimPreviewResponseDto> {
        const invitation = await this.invitations.findConsumable(token ?? '');
        const work = await this.workRepository.findById(invitation.workId);
        if (!work) {
            throw new BadRequestException('work_no_longer_exists');
        }

        return {
            workName: work.name,
            role: invitation.role,
            expiresAt: invitation.tokenExpiresAt.toISOString(),
            expectedProviderUsername:
                (invitation.metadata?.expectedProviderUsername as string | undefined) ?? null,
            sourceUrl: (work as { sourceUrl?: string }).sourceUrl ?? null,
        };
    }

    @Post('accept')
    @HttpCode(HttpStatus.OK)
    @UseGuards(AuthSessionGuard)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Accept a claim invitation',
        description:
            'Member-role acceptance creates a WorkMember row immediately. owner-claim acceptance records the claim and marks the repo transfer as pending — the actual repo hand-off completes via the git-provider plugin in a follow-up step.',
    })
    @ApiResponse({ status: 200, type: ClaimAcceptResponseDto })
    async accept(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() dto: ClaimAcceptDto,
    ): Promise<ClaimAcceptResponseDto> {
        const invitation = await this.invitations.findConsumable(dto.token);
        const claimant = await this.authService.getUser(auth.userId);

        if (invitation.role === INVITATION_ROLE_OWNER_CLAIM) {
            return this.acceptOwnerClaim(invitation, claimant.id);
        }
        return this.acceptMember(invitation, claimant.id);
    }

    private async acceptMember(
        invitation: WorkInvitation,
        claimantUserId: string,
    ): Promise<ClaimAcceptResponseDto> {
        if (
            invitation.role !== WorkMemberRole.MANAGER &&
            invitation.role !== WorkMemberRole.EDITOR &&
            invitation.role !== WorkMemberRole.VIEWER
        ) {
            throw new BadRequestException('invalid_role');
        }
        const work = await this.workRepository.findById(invitation.workId);
        if (!work) {
            throw new BadRequestException('work_no_longer_exists');
        }
        if (work.userId === claimantUserId) {
            throw new BadRequestException('claimant_is_already_owner');
        }

        const existing = await this.memberRepository.findMember(
            invitation.workId,
            claimantUserId,
        );
        if (existing) {
            throw new BadRequestException('already_a_member');
        }

        const consumed = await this.invitations.tryAccept(invitation.id, claimantUserId);
        if (!consumed) {
            throw new BadRequestException('invitation_state_changed');
        }

        await this.memberRepository.addMember(
            invitation.workId,
            claimantUserId,
            invitation.role as WorkMemberRole,
            invitation.invitedById,
        );

        return {
            invitationId: invitation.id,
            workId: invitation.workId,
            role: invitation.role,
            transferStatus: 'not_required',
        };
    }

    private async acceptOwnerClaim(
        invitation: WorkInvitation,
        claimantUserId: string,
    ): Promise<ClaimAcceptResponseDto> {
        const expectedUsername = invitation.metadata?.expectedProviderUsername as
            | string
            | undefined;
        if (!expectedUsername) {
            throw new BadRequestException('owner_claim_missing_provider_username');
        }

        const work = await this.workRepository.findById(invitation.workId);
        if (!work) {
            throw new BadRequestException('work_no_longer_exists');
        }

        const matches = await this.userMatchesProviderLogin(
            claimantUserId,
            (work as { gitProvider?: string }).gitProvider ?? null,
            expectedUsername,
        );
        if (!matches) {
            throw new ForbiddenException('claimant_provider_identity_mismatch');
        }

        const consumed = await this.invitations.tryAccept(invitation.id, claimantUserId);
        if (!consumed) {
            throw new BadRequestException('invitation_state_changed');
        }

        const transferState: WorkInvitationTransferState = {
            status: 'pending_recipient_acceptance',
        };
        await this.invitations.setTransferState(invitation.id, transferState);

        return {
            invitationId: invitation.id,
            workId: invitation.workId,
            role: invitation.role,
            transferStatus: transferState.status,
        };
    }

    private async userMatchesProviderLogin(
        userId: string,
        providerId: string | null,
        expectedLogin: string,
    ): Promise<boolean> {
        const accounts = await this.authAccountRepository.findProviderAccountsByUserId(userId);
        const expected = expectedLogin.trim().toLowerCase();
        for (const acc of accounts) {
            const accLogin = (acc.username ?? '').trim().toLowerCase();
            if (!accLogin) continue;
            if (providerId && acc.providerId !== providerId) continue;
            if (accLogin === expected) return true;
        }
        return false;
    }
}
