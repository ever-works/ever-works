import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { FacadesModule } from '@ever-works/agent/facades';
import { NotificationsModule as AgentNotificationsModule } from '@ever-works/agent/notifications';
// EW-711 #16: AgentsModule re-exports AgentRepository so EmailService can
// verify the caller owns the agentId named in a send (IDOR guard).
import { AgentsModule } from '@ever-works/agent/agents';
import { AuthModule } from '@src/auth';
// AW-05 — approve-before-send (EmailDraftService + the approvals-queue
// listener) and the send-policy services the facade gate is bound to.
import { EmailDraftsModule } from '@ever-works/agent/email';
import { OrganizationsModule } from '../organizations/organizations.module';
import { EmailController } from './email.controller';
import { EmailService } from './email.service';
import { EmailSendPolicyController } from './email-send-policy.controller';
import { AgentEmailAssignmentsController } from './agent-email-assignments.controller';
import { AgentEmailAssignmentsService } from './agent-email-assignments.service';

/**
 * EW-650 / EW-669 — Email module wiring.
 *
 * Re-uses FacadesModule's EmailFacadeService for plugin orchestration,
 * DatabaseModule for the new email_* repositories, and the agent
 * NotificationsModule for the AGENT_INBOUND_EMAIL_DISPATCHER token
 * (EW-670 / T25) that the inbound webhook routes parsed mail to.
 *
 * Mounted by the root api module alongside the existing MailModule
 * (v1 transactional email) and NotificationsModule. Both v1 surfaces
 * keep working unchanged — see notifications-v2 hard rule (additive).
 *
 * Agent email (AW-05) adds the draft loop, per-Agent / per-organization
 * send policy and the address-assignment routes. Enforcement itself is in
 * the facade's send path, not in any of these controllers.
 */
@Module({
    imports: [
        DatabaseModule,
        FacadesModule,
        AgentNotificationsModule,
        AgentsModule,
        AuthModule,
        EmailDraftsModule,
        // Organization policy writes are authorized by the shared membership
        // check. OrganizationsModule imports nothing email-side — no cycle.
        OrganizationsModule,
    ],
    controllers: [EmailController, EmailSendPolicyController, AgentEmailAssignmentsController],
    providers: [EmailService, AgentEmailAssignmentsService],
    exports: [EmailService],
})
export class EmailModule {}
