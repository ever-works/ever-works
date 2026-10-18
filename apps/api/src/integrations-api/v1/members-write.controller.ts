import { Body, Controller, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { IntegrationIdempotencyService } from '@ever-works/agent/integrations-api';
import { CurrentUser } from '../../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../../auth/types/auth.types';
import { RequireScopes } from '../../auth/integration/integration.decorators';
import {
    OrganizationInvitationFlowService,
    type IntegrationInviteOutcome,
} from '../../organizations/organization-invitation-flow.service';
import { ScopeContextService } from '../../scope/scope-context.service';
import { IntegrationOnlyGuard } from './integration-only.guard';
import { IntegrationExceptionFilter } from './integration-exception.filter';
import {
    runIdempotent,
    type IdempotentRequest,
    type IdempotentResponse,
} from './integration-idempotency';
import { pinnedOrganizationOf, principalOf } from './integration-request';

/** The roles an integration may invite with (contract v1: `member` only, CR-13). */
export const INTEGRATION_INVITE_ROLES = ['member'] as const;

/** Contract v1 `requests.schema.json#/$defs/InviteMember` (CR-13). */
export class IntegrationInviteMemberDto {
    @ApiProperty({
        description: 'Where the invitation is sent; the token is bound to this address.',
        maxLength: 320,
    })
    @IsEmail({}, { message: 'invalid_email' })
    @MaxLength(320, { message: 'invalid_email' })
    email!: string;

    @ApiProperty({
        required: false,
        enum: INTEGRATION_INVITE_ROLES,
        description:
            'The role the invitation grants (default `member`). Promotion stays the Tenant owner’s step in the app.',
    })
    @IsOptional()
    @IsIn([...INTEGRATION_INVITE_ROLES])
    role?: (typeof INTEGRATION_INVITE_ROLES)[number];

    @ApiProperty({
        required: false,
        maxLength: 200,
        description: 'Display name for the email copy only; never used for identity.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(200)
    invitedName?: string;
}

type Response = IdempotentResponse & { setHeader(name: string, value: string): unknown };

/** The wire shape (`resources/member-invite-result.schema.json`): never the token nor its hash. */
function resultOf(outcome: IntegrationInviteOutcome): Record<string, unknown> {
    const invitation = outcome.invitation;
    return {
        status: outcome.status,
        invitation: invitation
            ? {
                  id: invitation.id,
                  email: invitation.email,
                  role: invitation.role,
                  status: invitation.status,
                  expiresAt: new Date(invitation.tokenExpiresAt).toISOString(),
                  createdAt: new Date(invitation.createdAt).toISOString(),
              }
            : null,
        userId: outcome.userId,
    };
}

/**
 * `POST /api/integrations/v1/members/invite` (CR-13, scope `members:write`, in the Ever Gauzy preset;
 * `Idempotency-Key` required): invites a person into the pinned Organization with the app's own
 * invitation — the email-bound token, the normal invitation email, the seat check — sent by the
 * act-as user, else the key's owner. Idempotent per email: a pending invitation is answered again
 * (`200 pending`), a member is answered as one (`200 already_member`), and a person already in the
 * Tenant joins the roster directly (`201 added`, records `organization.member.added`); a new
 * invitation answers `201 invited`. The token never leaves the email.
 */
@ApiTags('Integrations API v1')
@Controller('api/integrations/v1')
@UseGuards(IntegrationOnlyGuard)
@UseFilters(IntegrationExceptionFilter)
export class IntegrationMembersWriteController {
    constructor(
        private readonly flow: OrganizationInvitationFlowService,
        private readonly scope: ScopeContextService,
        private readonly idempotency: IntegrationIdempotencyService,
    ) {}

    @Post('members/invite')
    @RequireScopes('members:write')
    @ApiOperation({
        summary:
            'Invite a person into the pinned organization (the normal invitation email; idempotent per email; Idempotency-Key required)',
    })
    async invite(
        @CurrentUser() user: AuthenticatedUser,
        @Body() dto: IntegrationInviteMemberDto,
        @Req() req: IdempotentRequest,
        @Res({ passthrough: true }) res: Response,
    ): Promise<unknown> {
        const principal = principalOf(user);
        const organizationId = pinnedOrganizationOf(this.scope.getScope().organizationId);
        return runIdempotent(this.idempotency, principal, req, res, async () => {
            const outcome = await this.flow.inviteForIntegration(
                organizationId,
                principal.actAsUserId ?? principal.ownerUserId,
                dto.email,
                { role: dto.role ?? 'member', invitedName: dto.invitedName },
            );
            const created = outcome.status === 'invited' || outcome.status === 'added';
            return { status: created ? 201 : 200, body: resultOf(outcome) };
        });
    }
}
