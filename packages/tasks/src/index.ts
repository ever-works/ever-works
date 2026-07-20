export * from './trigger/trigger.module';
// Tasks feature — Phase 15. Production dispatcher adapters that
// fan out platform Task events to the Trigger.dev runtime. API-side
// TasksModule binds these to the dispatcher tokens.
export * from './dispatchers/agent-task-dispatchers';
// PR-4 — Idea → Work build executor dispatch adapter. API-side
// IdeaBuildExecutorDispatchModule binds this to the
// IDEA_BUILD_EXECUTE_DISPATCHER token.
export * from './dispatchers/idea-build-execute.dispatcher';
