import {
    Body,
    Controller,
    Get,
    NotFoundException,
    Param,
    Patch,
    Put,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
    AgentInboxService,
    EmailSendPolicyService,
    toAgentInboxDto,
    type AgentInboxSettingsPatch,
} from '@ever-works/agent/email';
import { config } from '@ever-works/agent/config';
import type { EmailSendPolicyOverride } from '@ever-works/contracts';
import { AuthSessionGuard, CurrentUser } from '../auth';
import { AuthenticatedUser } from '@src/auth/types/auth.types';
import { OrganizationMembershipService } from '../organizations/organization-membership.service';
import { ScopeContextService } from '../scope/scope-context.service';
import {
    UpdateAgentInboxDto,
    UpdateOrganizationEmailSendPolicyDto,
} from './dto/email-send-policy.dto';

/**
 * Agent email (AW-05) — who may send how much, and whether an Agent's mail
 * waits for a person.
 *
 *   GET   /api/email/inboxes                         my Agents' inbox settings
 *   GET   /api/email/agents/:agentId/send-policy     settings + live ceiling meter
 *   PUT   /api/email/agents/:agentId/inbox           create-or-update settings (idempotent)
 *   GET   /api/email/organization/send-policy        active organization's policy
 *   PATCH /api/email/organization/send-policy        change it (organization admin)
 *
 * Every Agent route is owner-scoped in the service: a foreign Agent id gets
 * the same 404 as a missing one. The organization is NEVER taken from the
 * request — it is the session's active organization, re-authorized through
 * the shared membership check, the same posture as the digest settings.
 *
 * These routes only change policy. Enforcement lives in the send path
 * (`EmailFacadeService.send`), so nothing here can be skipped by a caller
 * that sends some other way.
 */
@ApiTags('Email')
@Controller('api/email')
@UseGuards(AuthSessionGuard)
@ApiBearerAuth('JWT-auth')
export class EmailSendPolicyController {
    constructor(
        private readonly inboxes: AgentInboxService,
        private readonly policy: EmailSendPolicyService,
        private readonly membership: OrganizationMembershipService,
        private readonly scopeContext: ScopeContextService,
    ) {}

    @Get('inboxes')
    @ApiOperation({ summary: "List my Agents' email inbox settings" })
    async listInboxes(@CurrentUser() auth: AuthenticatedUser) {
        const rows = await this.inboxes.list(auth.userId);
        return { inboxes: rows.map(toAgentInboxDto) };
    }

    @Get('agents/:agentId/send-policy')
    @ApiOperation({
        summary:
            "An Agent's approval mode and send ceilings, with where each came from and how much of each is used",
    })
    async getAgentSendPolicy(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId') agentId: string,
    ) {
        const inbox = await this.inboxes.findForAgent(auth.userId, agentId);
        const meter = await this.policy.getMeter(auth.userId, agentId);
        return { inbox: inbox ? toAgentInboxDto(inbox) : null, meter };
    }

    @Put('agents/:agentId/inbox')
    @ApiOperation({
        summary:
            "Create or change an Agent's inbox settings. A new row starts in draft review unless a mode is given.",
    })
    async upsertAgentInbox(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('agentId') agentId: string,
        @Body() body: UpdateAgentInboxDto,
    ) {
        const patch = toSettingsPatch(body);
        const ensured = await this.inboxes.ensure(auth.userId, agentId, patch);
        const inbox = ensured.created
            ? ensured.inbox
            : await this.inboxes.update(auth.userId, ensured.inbox.id, patch);
        const meter = await this.policy.getMeter(auth.userId, agentId);
        return { inbox: toAgentInboxDto(inbox), created: ensured.created, meter };
    }

    @Get('organization/send-policy')
    @ApiOperation({ summary: "The active organization's email sending policy" })
    async getOrganizationPolicy(@CurrentUser() auth: AuthenticatedUser) {
        const organizationId = await this.resolveActiveOrganizationId(auth.userId, 'read');
        return this.describeOrganization(
            organizationId,
            await this.policy.readOrganizationPolicy(organizationId),
        );
    }

    @Patch('organization/send-policy')
    @ApiOperation({
        summary:
            "Change the active organization's email sending policy (field by field; null clears back to the platform default).",
    })
    async updateOrganizationPolicy(
        @CurrentUser() auth: AuthenticatedUser,
        @Body() body: UpdateOrganizationEmailSendPolicyDto,
    ) {
        const organizationId = await this.resolveActiveOrganizationId(auth.userId, 'write');
        const patch: EmailSendPolicyOverride = {};
        if (body.defaultMode !== undefined) patch.defaultMode = body.defaultMode;
        if (body.caps !== undefined) patch.caps = body.caps ? { ...body.caps } : null;
        const stored = await this.policy.updateOrganizationPolicy(organizationId, patch);
        return this.describeOrganization(organizationId, stored);
    }

    private describeOrganization(organizationId: string, policy: EmailSendPolicyOverride | null) {
        return {
            organizationId,
            policy,
            platform: {
                enforced: config.email.sendCaps.isEnforced(),
                caps: config.email.sendCaps.getPlatformCaps(),
                defaultMode: config.email.getDefaultAgentMode(),
            },
        };
    }

    /**
     * The session's active organization, re-authorized: `read` → member,
     * `write` → admin. No active organization is the same 404 a foreign one
     * gets.
     */
    private async resolveActiveOrganizationId(
        userId: string,
        access: 'read' | 'write',
    ): Promise<string> {
        const organizationId = this.scopeContext.getOrganizationId();
        if (!organizationId) {
            throw new NotFoundException('No active organization for this session');
        }
        if (access === 'write') {
            await this.membership.ensureAdmin(organizationId, userId);
        } else {
            await this.membership.ensureMember(organizationId, userId);
        }
        return organizationId;
    }
}

function toSettingsPatch(body: UpdateAgentInboxDto): AgentInboxSettingsPatch {
    const patch: AgentInboxSettingsPatch = {};
    if (body.mode !== undefined) patch.mode = body.mode;
    if (body.emailAddressId !== undefined) patch.emailAddressId = body.emailAddressId;
    if (body.dailySendCap !== undefined) patch.dailySendCap = body.dailySendCap;
    if (body.burstSendCap !== undefined) patch.burstSendCap = body.burstSendCap;
    if (body.recipientBurstCap !== undefined) patch.recipientBurstCap = body.recipientBurstCap;
    if (body.recipientsPerMessageCap !== undefined) {
        patch.recipientsPerMessageCap = body.recipientsPerMessageCap;
    }
    return patch;
}
