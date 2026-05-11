import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    ParseUUIDPipe,
    Post,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOperation,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { WorkInvitationService, WorkOwnershipService } from '@ever-works/agent/services';
import {
    INVITATION_ROLE_OWNER_CLAIM,
    type InvitationRole,
    WorkInvitation,
    WorkInvitationStatus,
} from '@ever-works/agent/entities';
import { AuthService, AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { config } from '../config/constants';
import { WorkInvitationIssuedEvent } from '../events';
import { CreateInvitationDto, InvitationResponseDto } from './dto/create-invitation.dto';

@ApiTags('Invitations')
@ApiBearerAuth('JWT-auth')
@Controller('api/works/:workId/invitations')
@UseGuards(AuthSessionGuard)
export class InvitationsController {
    constructor(
        private readonly invitations: WorkInvitationService,
        private readonly ownership: WorkOwnershipService,
        private readonly authService: AuthService,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @ApiOperation({
        summary: 'Issue a tokenised invitation',
        description:
            'Creates a pending invitation with a single-use claim token. owner-claim invitations require Owner role and an expectedProviderUsername; member-role invitations only need Manager+. The raw token is returned ONCE inside `claimUrl`.',
    })
    @ApiResponse({ status: 201, type: InvitationResponseDto })
    async create(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId', new ParseUUIDPipe()) workId: string,
        @Body() dto: CreateInvitationDto,
    ): Promise<InvitationResponseDto> {
        const user = await this.authService.getUser(auth.userId);

        const { work } = dto.role === INVITATION_ROLE_OWNER_CLAIM
            ? await this.ownership.ensureIsOwner(workId, user.id)
            : await this.ownership.ensureCanManageMembers(workId, user.id);

        const expectedProviderUsername =
            dto.expectedProviderUsername ??
            (dto.metadata?.expectedProviderUsername as string | undefined);

        if (dto.role === INVITATION_ROLE_OWNER_CLAIM && !expectedProviderUsername) {
            throw new BadRequestException(
                'owner-claim invitations require expectedProviderUsername',
            );
        }

        if (dto.role !== INVITATION_ROLE_OWNER_CLAIM && !dto.email) {
            throw new BadRequestException(
                'email is required for member-role invitations',
            );
        }

        const metadata = {
            ...(dto.metadata ?? {}),
            ...(expectedProviderUsername ? { expectedProviderUsername } : {}),
        };

        const { invitation, token } = await this.invitations.issue({
            workId,
            invitedById: user.id,
            role: dto.role as InvitationRole,
            email: dto.email ?? null,
            expiresInDays: dto.expiresInDays,
            metadata: Object.keys(metadata).length > 0 ? metadata : null,
        });

        const claimUrl = `${config.webAppUrl()}/claim/${token}`;

        this.eventEmitter.emit(
            WorkInvitationIssuedEvent.EVENT_NAME,
            new WorkInvitationIssuedEvent(
                user,
                work,
                invitation.role,
                claimUrl,
                invitation.email,
                invitation.tokenExpiresAt,
                expectedProviderUsername ?? null,
            ),
        );

        return this.toResponse(invitation, claimUrl);
    }

    @Get()
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'List pending invitations for the work' })
    async list(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId', new ParseUUIDPipe()) workId: string,
    ): Promise<{ status: 'success'; invitations: InvitationResponseDto[] }> {
        const user = await this.authService.getUser(auth.userId);
        await this.ownership.ensureCanManageMembers(workId, user.id);

        const pending = await this.invitations.listPending(workId);
        return {
            status: 'success',
            invitations: pending.map((inv) => this.toResponse(inv)),
        };
    }

    @Delete(':invitationId')
    @HttpCode(HttpStatus.OK)
    @ApiOperation({ summary: 'Revoke a pending invitation' })
    async revoke(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('workId', new ParseUUIDPipe()) workId: string,
        @Param('invitationId', new ParseUUIDPipe()) invitationId: string,
    ): Promise<{ status: 'success' }> {
        const user = await this.authService.getUser(auth.userId);
        await this.ownership.ensureCanManageMembers(workId, user.id);

        const invitation = await this.invitations.listPending(workId);
        const exists = invitation.some((i) => i.id === invitationId);
        if (!exists) {
            throw new NotFoundException('invitation_not_found');
        }

        await this.invitations.revoke(invitationId, user.id);
        return { status: 'success' };
    }

    private toResponse(invitation: WorkInvitation, claimUrl?: string): InvitationResponseDto {
        const dto: InvitationResponseDto = {
            id: invitation.id,
            workId: invitation.workId,
            role: invitation.role,
            email: invitation.email ?? null,
            status: invitation.status as WorkInvitationStatus,
            tokenExpiresAt: invitation.tokenExpiresAt.toISOString(),
            createdAt: invitation.createdAt.toISOString(),
            invitedById: invitation.invitedById,
            metadata: invitation.metadata ?? null,
        };
        if (claimUrl) {
            dto.claimUrl = claimUrl;
        }
        return dto;
    }
}
