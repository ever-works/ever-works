import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    ParseUUIDPipe,
    Post,
    UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { OrganizationOwnershipGuard } from './guards/organization-ownership.guard';
import { OrganizationInvitationFlowService } from './organization-invitation-flow.service';
import { CreateOrganizationInvitationDto } from './dto/create-organization-invitation.dto';

/** Wire shape for a pending invitation. 🛑 Never carries the token. */
export interface OrganizationInvitationResponse {
    id: string;
    email: string;
    role: string;
    status: string;
    invitedById: string;
    tokenExpiresAt: Date;
    acceptedAt: Date | null;
    createdAt: Date;
}

export interface OrganizationMemberResponse {
    id: string;
    userId: string;
    role: string;
    invitedById: string | null;
    joinedAt: Date;
}

/**
 * Organization membership — issuance side.
 *
 * Every route is object-level authorized by `OrganizationOwnershipGuard`
 * (class-level; all routes carry `:orgId`), which requires the caller to
 * already be a member and 404s rather than 403s, so these endpoints cannot be
 * used to probe which Organization ids exist. Same posture as
 * `TeamsController`.
 *
 * 🛑 The invitation TOKEN is never returned by any route here, not even to the
 * issuer. It exists only inside the email. A token echoed into an API response
 * ends up in browser history, proxy logs and screenshots, and it grants
 * tenant-wide access — the one-way `sha256` in the database is pointless if
 * the plaintext is handed back over HTTP.
 */
@ApiTags('Organizations')
@ApiBearerAuth('JWT-auth')
@Controller('api/organizations/:orgId')
@UseGuards(AuthSessionGuard, OrganizationOwnershipGuard)
export class OrganizationInvitationsController {
    constructor(private readonly flow: OrganizationInvitationFlowService) {}

    @Get('members')
    @ApiOperation({ summary: 'List the members of an Organization' })
    @ApiResponse({ status: 200, description: 'Members listed' })
    async listMembers(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<OrganizationMemberResponse[]> {
        const members = await this.flow.listMembers(orgId, user.userId);
        return members.map((m) => ({
            id: m.id,
            userId: m.userId,
            role: m.role,
            invitedById: m.invitedById,
            joinedAt: m.joinedAt,
        }));
    }

    @Get('invitations')
    @ApiOperation({ summary: 'List invitations issued for an Organization' })
    @ApiResponse({ status: 200, description: 'Invitations listed' })
    async listInvitations(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<OrganizationInvitationResponse[]> {
        const invitations = await this.flow.listInvitations(orgId, user.userId);
        return invitations.map((i) => this.toResponse(i));
    }

    @Post('invitations')
    // Tighter than the 30/min the org-scoped writes use: this endpoint causes
    // an email to be sent to an arbitrary address, so it is a spam vector as
    // well as a write.
    @Throttle({ long: { limit: 10, ttl: 60_000 } })
    @ApiOperation({
        summary: 'Invite a person into an Organization',
        description:
            'Sends an email carrying a single-use, email-bound token. The token is ' +
            'never returned in the response.',
    })
    @ApiResponse({ status: 201, description: 'Invitation issued and emailed' })
    @ApiResponse({ status: 409, description: 'A pending invitation already exists' })
    async invite(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: CreateOrganizationInvitationDto,
    ): Promise<OrganizationInvitationResponse> {
        const { invitation } = await this.flow.invite(
            orgId,
            user.userId,
            dto.email,
            dto.invitedName,
        );
        // `invitation` only — the raw token is deliberately dropped here.
        return this.toResponse(invitation);
    }

    @Delete('invitations/:invitationId')
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({ summary: 'Revoke a pending invitation' })
    @ApiResponse({ status: 204, description: 'Invitation revoked' })
    async revoke(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('invitationId', ParseUUIDPipe) invitationId: string,
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<void> {
        await this.flow.revokeInvitation(orgId, invitationId, user.userId);
    }

    @Delete('members/:userId')
    @Throttle({ long: { limit: 30, ttl: 60_000 } })
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiOperation({
        summary: 'Remove a member from an Organization',
        description:
            'Deletes the roster row. If this was their last membership in the ' +
            'Tenant, their users.tenantId is cleared so they can own an ' +
            'Organization of their own again. No other data is deleted.',
    })
    @ApiResponse({ status: 204, description: 'Member removed' })
    @ApiResponse({ status: 400, description: 'Not a member, or is the Tenant owner' })
    async removeMember(
        @Param('orgId', ParseUUIDPipe) orgId: string,
        @Param('userId', ParseUUIDPipe) targetUserId: string,
        @CurrentUser() user: AuthenticatedUser,
    ): Promise<void> {
        await this.flow.removeMember(orgId, targetUserId, user.userId);
    }

    private toResponse(i: {
        id: string;
        email: string;
        role: string;
        status: string;
        invitedById: string;
        tokenExpiresAt: Date;
        acceptedAt: Date | null;
        createdAt: Date;
    }): OrganizationInvitationResponse {
        return {
            id: i.id,
            email: i.email,
            role: i.role,
            status: i.status,
            invitedById: i.invitedById,
            tokenExpiresAt: i.tokenExpiresAt,
            acceptedAt: i.acceptedAt,
            createdAt: i.createdAt,
        };
    }
}
