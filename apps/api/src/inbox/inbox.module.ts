import { Global, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
    InboxModule as AgentInboxModule,
    InboxService,
    INBOX_PRODUCER,
    type InboxProducer,
} from '@ever-works/agent/inbox';
import { AuthModule } from '../auth/auth.module';
import { InboxController } from './inbox.controller';

/**
 * Inbox (operator message center) — api-side module exposing
 * `/api/inbox` and binding the `INBOX_PRODUCER` token.
 *
 * `@Global()` for the same reason as the api-side AgentsModule: the
 * producers that consume the token (`AgentEscalationService`,
 * `AgentApprovalsService`, `InboxBudgetAlertListener`) live in OTHER
 * modules that must not import the inbox graph — their reach into the
 * inbox is `@Optional() @Inject(INBOX_PRODUCER)` on a leaf token file.
 * Without @Global() those injections silently resolve to undefined in
 * production and no escalation / proposal ever mirrors into the inbox
 * despite every unit test passing.
 *
 * ## Why the binding is a LAZY factory and not `useExisting`
 *
 * `INBOX_PRODUCER` and `InboxService` form a real dependency CYCLE:
 * `InboxService` injects `AgentApprovalsService` + `AgentEscalationService`
 * (the reply router proxies decisions to them), and both of those inject
 * `@Optional() @Inject(INBOX_PRODUCER)` (the create-time mirror). Bound
 * with `useExisting: InboxService`, Nest's instance loader has to finish
 * constructing InboxService to satisfy the token, and has to satisfy the
 * token to finish constructing AgentApprovalsService — so
 * `ApplicationContext.init()` NEVER SETTLES. Not a crash, not a warning:
 * `apps/api` hangs before it listens, the pod never turns ready, and the
 * only symptom is a rollout that silently never completes. `@Optional()`
 * does not save it — optional covers a MISSING provider, not a pending
 * one.
 *
 * Resolving `InboxService` lazily through `ModuleRef` at CALL time breaks
 * the construction-time edge (the factory's only dependency is ModuleRef)
 * while keeping the producer a true singleton pass-through. Pinned by
 * `__tests__/inbox.module.spec.ts`.
 */
@Global()
@Module({
    imports: [AgentInboxModule, AuthModule],
    controllers: [InboxController],
    providers: [
        {
            provide: INBOX_PRODUCER,
            inject: [ModuleRef],
            useFactory: (moduleRef: ModuleRef): InboxProducer => {
                // Resolved on first use — long after bootstrap, so the
                // cycle above never has to be satisfied eagerly.
                const inbox = () => moduleRef.get(InboxService, { strict: false });
                return {
                    escalationRaised: (input) => inbox().escalationRaised(input),
                    proposalPending: (input) => inbox().proposalPending(input),
                    notice: (userId, input) => inbox().notice(userId, input),
                    // Self-build slice Q — the fleet reconciler's question path.
                    questionRaised: (input) => inbox().questionRaised(input),
                };
            },
        },
    ],
    exports: [INBOX_PRODUCER],
})
export class InboxApiModule {}
