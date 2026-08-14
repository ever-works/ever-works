import { Global, Module } from '@nestjs/common';
import { InboxModule as AgentInboxModule, InboxService, INBOX_PRODUCER } from '@ever-works/agent/inbox';
import { AuthModule } from '../auth/auth.module';
import { InboxController } from './inbox.controller';

/**
 * Inbox (operator message center) — api-side module exposing
 * `/api/inbox` and binding the `INBOX_PRODUCER` token.
 *
 * `@Global()` for the same reason as the api-side AgentsModule: the
 * producers that consume the token (`AgentEscalationService`,
 * `AgentApprovalsService`, `BudgetAlertHandler`) live in OTHER modules
 * that must not import the inbox graph — their reach into the inbox is
 * `@Optional() @Inject(INBOX_PRODUCER)` on a leaf token file. Without
 * @Global() those injections silently resolve to undefined in
 * production and no escalation / proposal ever mirrors into the inbox
 * despite every unit test passing.
 */
@Global()
@Module({
    imports: [AgentInboxModule, AuthModule],
    controllers: [InboxController],
    providers: [{ provide: INBOX_PRODUCER, useExisting: InboxService }],
    exports: [INBOX_PRODUCER],
})
export class InboxApiModule {}
