import { Module } from '@nestjs/common';
import { AgentApprovalsModule } from '../agent-approvals/agent-approvals.module';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { EmailDraftApprovalListener } from './email-draft-approval.listener';
import { EmailDraftService } from './email-draft.service';
import { EmailSendPolicyModule } from './email-send-policy.module';

/**
 * Agent email (AW-05) — the draft loop (`EmailDraftService`) plus the
 * listener that acts on decisions made in the approvals queue.
 *
 * This module sits ABOVE the facade layer (it sends through
 * `EmailFacadeService`), so it is imported by the API's email module and
 * never by `FacadesModule` — the policy gate the facade needs lives in the
 * separate `EmailSendPolicyModule` for exactly that reason.
 */
@Module({
    imports: [DatabaseModule, FacadesModule, AgentApprovalsModule, EmailSendPolicyModule],
    providers: [EmailDraftService, EmailDraftApprovalListener],
    exports: [EmailDraftService, EmailSendPolicyModule],
})
export class EmailDraftsModule {}
