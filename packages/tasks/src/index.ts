export * from './trigger/trigger.module';
// TriggerService is consumed directly by the API's AgentsModule (#1741 —
// AGENT_RUN_CANCELLER factory). trigger.module only lists it in the NestJS DI
// `exports` array (a runtime binding, not a TS export), so re-export the class
// itself here or `import { TriggerService } from '@ever-works/trigger-tasks'`
// fails to type-check (TS2305) and the API build breaks.
export { TriggerService } from './trigger/trigger.service';
// Tasks feature — Phase 15. Production dispatcher adapters that
// fan out platform Task events to the Trigger.dev runtime. API-side
// TasksModule binds these to the dispatcher tokens.
export * from './dispatchers/agent-task-dispatchers';
// PR-4 — Idea → Work build executor dispatch adapter. API-side
// IdeaBuildExecutorDispatchModule binds this to the
// IDEA_BUILD_EXECUTE_DISPATCHER token.
export * from './dispatchers/idea-build-execute.dispatcher';
