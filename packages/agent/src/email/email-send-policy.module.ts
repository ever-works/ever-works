import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AgentInboxService } from './agent-inbox.service';
import { EMAIL_SEND_POLICY_GATE } from './email-send-policy.port';
import { EmailSendPolicyService } from './email-send-policy.service';

/**
 * Agent email (AW-05) — binds `EMAIL_SEND_POLICY_GATE` and owns the inbox
 * settings service.
 *
 * Import direction: `FacadesModule` → here → `DatabaseModule`. Nothing here
 * imports the facade layer, so the graph stays acyclic — the same shape
 * `MergeApprovalModule` uses to be importable from `FacadesModule`.
 * `DatabaseModule` provides both repositories this module reads through
 * and re-exports `TypeOrmModule` with every entity (Agent, Organization,
 * AgentActionProposal).
 *
 * The token is bound with `useExisting` so the facade depends on the
 * CONTRACT, never on the concrete class.
 */
@Module({
    imports: [DatabaseModule],
    providers: [
        EmailSendPolicyService,
        AgentInboxService,
        { provide: EMAIL_SEND_POLICY_GATE, useExisting: EmailSendPolicyService },
    ],
    exports: [EmailSendPolicyService, AgentInboxService, EMAIL_SEND_POLICY_GATE],
})
export class EmailSendPolicyModule {}
