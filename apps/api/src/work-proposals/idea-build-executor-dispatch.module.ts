import { Global, Module } from '@nestjs/common';
import { IDEA_BUILD_EXECUTE_DISPATCHER } from '@ever-works/agent/work-agent';
import { ideaBuildExecuteTriggerAdapter } from '@ever-works/trigger-tasks';

/**
 * PR-4 (domain-model evolution) — binds the production Trigger.dev
 * adapter to the `IDEA_BUILD_EXECUTE_DISPATCHER` token.
 *
 * `@Global()` for the same reason the Tasks-feature dispatcher module
 * is global: the consumers live in *different* modules from where the
 * token is provided — `WorkProposalsApiService` (WorkProposalsModule)
 * and `MissionTickService` (the agent-package MissionsModule, resolved
 * over RPC in the API process). NestJS does not propagate a child
 * module's providers up into an imported module's DI scope, so without
 * `@Global()` the `@Optional() @Inject(IDEA_BUILD_EXECUTE_DISPATCHER)`
 * in those services would silently resolve to `undefined` and the
 * enqueue would never fire even with the feature flag on.
 *
 * The adapter itself is inert until the flag is flipped — every
 * enqueue site checks `config.ideaBuildExecutor.isEnabled()` first.
 */
@Global()
@Module({
    providers: [
        { provide: IDEA_BUILD_EXECUTE_DISPATCHER, useValue: ideaBuildExecuteTriggerAdapter },
    ],
    exports: [IDEA_BUILD_EXECUTE_DISPATCHER],
})
export class IdeaBuildExecutorDispatchModule {}
