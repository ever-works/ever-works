import { task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import type { TaskAcceptanceCheck } from '@ever-works/contracts';
import { AgentRepository, AgentRunRepository, WorkRepository } from '@ever-works/agent/database';
import { AgentRunService, RunDispatchGateService } from '@ever-works/agent/agents';
import {
    resolveAcceptanceChecks,
    resolveChecksPolicy,
    TaskChatService,
    TaskGateRunnerService,
    TaskRunDenormService,
    TasksService,
    TaskWorkspaceService,
} from '@ever-works/agent/tasks-domain';
import { TriggerInternalModule } from '../../trigger/worker/modules/trigger-internal.module';
import { createTriggerLogger } from '../../trigger/worker/trigger-logger';
// Security: import assertUuid to validate Trigger.dev payload fields before any DB access
import { assertUuid } from '../../trigger/worker/utils/task-context.utils';

/**
 * Security (prompt-injection hardening): chat-template control markers that
 * some models treat as out-of-band role/turn delimiters. Mirrors the
 * `CHAT_TEMPLATE_MARKER_PATTERN` shared by the prompt assembler
 * (`@ever-works/agent` `prompt-assembler.service.ts`
 * `neutralizeInjectedBlock`) and the standard pipeline's prompt utils.
 */
const CHAT_TEMPLATE_MARKER_PATTERN =
    /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>/gi;

/**
 * Security (prompt-injection hardening): `taskRow.title` / `taskRow.description`
 * are attacker-controlled for inbound-email-spawned Tasks (the email subject /
 * body land verbatim in those fields). They are interpolated into
 * `immediateInput`, the single user message that drives the agent's tool loop,
 * so a crafted title/description containing a chat-template control marker
 * (e.g. `<|im_start|>system`) could spoof a system/user turn and nudge tool
 * use. Strip those control tokens before the field enters the prompt. This is
 * a pure mechanical strip — newlines, whitespace, and all benign content pass
 * through unchanged, so legitimate Task fields are unaffected; only the
 * forgeable control markers are defused.
 */
function neutralizeControlTokens(value: string): string {
    return value.replace(CHAT_TEMPLATE_MARKER_PATTERN, '');
}

/**
 * Kanban run cockpit (Wave 2) — the latest-run denorm + telemetry writes
 * are board decoration, never source of truth (`agent_runs` is). They go
 * over the internal RPC proxy, so the transport itself can throw even
 * though `TaskRunDenormService` swallows its own DB errors — wrap every
 * call so a telemetry hiccup can never fail or skip the run.
 */
async function bestEffort(write: () => Promise<unknown>): Promise<void> {
    try {
        await write();
    } catch {
        // Best-effort by contract.
    }
}

export interface AgentTaskExecutePayload {
    agentId: string;
    userId: string;
    taskId: string;
    runId?: string;
    /** Deduplication key — `${taskId}:${agentId}:${generation}`. */
    dedupKey: string;
}

/**
 * Tasks feature — Phase 15.1.
 *
 * One-shot Trigger.dev task that executes an Agent-on-Task run.
 * Dispatched by `TaskTransitionService` on `* → in_progress` when
 * any Agent assignee is present (dedup by `(taskId, agentId,
 * generation)` so a rapid in_progress → in_review → in_progress
 * flip doesn't double-fire).
 *
 * v1 is a placeholder — wires the queued AgentRun row + marks it
 * started + completed with a stub summary, then releases. The real
 * orchestrator (`AgentRunService.execute` with kind='task'`) plumbs
 * once the LLM dispatch path lands. Status carries through to the
 * UI via the AgentRun row + AGENT_HEARTBEAT_* activity events.
 *
 * maxDuration = 60min per `features/task-tracking/plan.md §15`.
 */
export const agentTaskExecuteTask = task<'agent-task-execute', AgentTaskExecutePayload>({
    id: 'agent-task-execute',
    maxDuration: 3600,
    onFailure: async ({ payload, error }) => {
        if (!payload) return;
        // Security: validate payload IDs before any DB access (defense-in-depth, mirrors agent-heartbeat)
        assertUuid(payload.agentId, 'payload.agentId');
        assertUuid(payload.userId, 'payload.userId');
        assertUuid(payload.taskId, 'payload.taskId');
        try {
            const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
            appContext.useLogger(createTriggerLogger('AgentTaskExecute:Failure'));
            try {
                const runs = appContext.get(AgentRunRepository);
                const message = error instanceof Error ? error.message : String(error);
                const inFlight = payload.runId
                    ? await runs.findById(payload.runId)
                    : await runs.findInFlightForTaskAgent(payload.taskId, payload.agentId);
                if (inFlight && (inFlight.status === 'queued' || inFlight.status === 'running')) {
                    await runs.markFailed(inFlight.id, message);
                    // Kanban run cockpit — mirror the failure onto the board.
                    const denorm = appContext.get(TaskRunDenormService);
                    await bestEffort(() =>
                        denorm.recordTerminal(payload.taskId, inFlight.id, 'failed'),
                    );
                    // Run orchestration (Wave 4 M2) — the failure freed a
                    // concurrency slot; drain the Work's parked queue (RPC).
                    if (inFlight.workId) {
                        const failedWorkId = inFlight.workId;
                        const gate = appContext.get(RunDispatchGateService);
                        await bestEffort(() => gate.drainForWork(failedWorkId));
                    }
                }
            } finally {
                await appContext.close();
            }
        } catch {
            // Best-effort — stuck-row sweep will recover.
        }
    },
    run: async (
        payload: AgentTaskExecutePayload,
        // NOTE: this annotation replaces the SDK RunFnParams, so anything omitted
        // here is silently invisible — which is exactly how `signal` went unused.
        { ctx, signal }: { ctx?: { run?: { id?: string } }; signal?: AbortSignal } = {},
    ) => {
        // Security: validate payload IDs before any DB access (defense-in-depth, mirrors agent-heartbeat)
        assertUuid(payload.agentId, 'payload.agentId');
        assertUuid(payload.userId, 'payload.userId');
        assertUuid(payload.taskId, 'payload.taskId');
        const appContext = await NestFactory.createApplicationContext(TriggerInternalModule);
        appContext.useLogger(createTriggerLogger('AgentTaskExecute'));

        try {
            const agents = appContext.get(AgentRepository);
            const runs = appContext.get(AgentRunRepository);
            const runner = appContext.get(AgentRunService);
            const tasks = appContext.get(TasksService);
            // Kanban run cockpit (Wave 2) — latest-run denorm writes after
            // claim + terminal transitions. RPC proxy; every call best-effort.
            const runDenorm = appContext.get(TaskRunDenormService);
            // Run orchestration (Wave 4 M2) — drain-on-terminal: every
            // terminal write below frees a concurrency slot, so the Work's
            // parked queue is drained (RPC proxy; always best-effort).
            const dispatchGate = appContext.get(RunDispatchGateService);
            const drainWork = async (workId: string | null | undefined): Promise<void> => {
                if (!workId) return;
                await bestEffort(() => dispatchGate.drainForWork(workId));
            };

            // Security: scope the Agent lookup to the payload's userId
            // (defense-in-depth IDOR guard). The legitimate dispatch path
            // (`TaskTransitionService.fanOutAgentExecutions`) always derives
            // `agentId` from an assignee of a task the `userId` owns, so this
            // never rejects a real run — but if the Trigger.dev payload is
            // forged with another tenant's `agentId`, `findByIdAndUser`
            // returns null and we skip instead of executing a cross-tenant
            // Agent. Mirrors `AgentRunRepository.findByIdAndUser` ownership
            // posture (architecture/security §9, no-existence-leak).
            const agent = await agents.findByIdAndUser(payload.agentId, payload.userId);
            if (!agent) {
                // Security: do not echo the caller-supplied `agentId` back in
                // the skip response — it would reflect a (possibly forged /
                // cross-tenant) UUID into the persisted Trigger.dev run record
                // and act as an existence oracle for dashboard-scoped viewers.
                return { status: 'skipped', reason: 'agent-not-found' };
            }

            // Security: scope the Task lookup to the payload's userId before
            // we link/create any AgentRun row (IDOR guard). `getOne` resolves
            // via `TaskRepository.findByIdAndUser` and throws an
            // existence-leak-safe 404 for a foreign/non-owned `taskId`, so a
            // forged payload that pairs an owned `agentId` with another
            // tenant's `taskId` cannot attach a run to that task. The
            // legitimate dispatch path (`TaskTransitionService`) always derives
            // `taskId` from a task the `userId` owns, so this never rejects a
            // real run. We resolve `taskRow` here (instead of after
            // markStarted) and reuse it for prompt assembly below — null only
            // for a foreign/missing task, in which case we skip without
            // mutating any run state. The reason is non-leaking and does not
            // echo the caller-supplied `taskId`.
            const taskRow = await tasks.getOne(payload.userId, payload.taskId).catch(() => null);
            if (!taskRow) {
                return { status: 'skipped', reason: 'task-not-found' };
            }

            // Look up the dispatcher-queued in-flight run (created when
            // TaskTransitionService fanned out the dispatch). If we
            // don't find one, create on the fly so the audit trail is
            // consistent.
            let run = payload.runId ? await runs.findById(payload.runId) : null;
            if (run && (run.agentId !== agent.id || run.taskId !== payload.taskId)) {
                return {
                    status: 'skipped',
                    reason: 'run-payload-mismatch',
                    agentId: payload.agentId,
                };
            }
            if (run && run.status !== 'queued' && run.status !== 'running') {
                return {
                    status: 'skipped',
                    reason: `run-${run.status}`,
                    agentId: agent.id,
                    taskId: payload.taskId,
                    runId: run.id,
                    dedupKey: payload.dedupKey,
                };
            }
            if (!run) {
                run = await runs.findInFlightForTaskAgent(payload.taskId, payload.agentId);
            }
            if (!run) {
                run = await runs.createQueued({
                    agentId: agent.id,
                    userId: agent.userId,
                    triggerKind: 'task',
                    taskId: payload.taskId,
                    // Wave 4 M1 — workId denorm at creation (owner-scoped
                    // taskRow resolved above).
                    workId: taskRow.workId ?? null,
                });
                // Kanban run cockpit — on-the-fly creation (dispatcher row was
                // never found), mirror it exactly like the fan-out path does.
                const createdRunId = run.id;
                await bestEffort(() => runDenorm.recordQueued(payload.taskId, createdRunId));
            }

            const claimed = await runs.markStarted(run.id, ctx?.run?.id ?? null);
            // Honour the CAS: markStarted returns false when the row went terminal
            // first — a user cancel, or the stuck-run sweeper reaping it. Executing
            // anyway would burn the work and then lose it, because the terminal
            // write at the end no-ops against the same guard. No behaviour change on
            // the happy path: the CAS allows queued|running, so a legitimate retry
            // re-claiming an already-running row still returns true.
            if (!claimed) {
                return { status: 'skipped', reason: 'run-already-terminal', runId: run.id };
            }
            // Kanban run cockpit — claim succeeded: flip the board chip to
            // `running` and seed the live-activity line so the card shows
            // what the run is doing from its very first seconds.
            const claimedRunId = run.id;
            await bestEffort(() => runDenorm.recordStarted(payload.taskId, claimedRunId));
            await bestEffort(() =>
                runs.updateTelemetry(claimedRunId, {
                    currentActivity: `Executing task ${taskRow.slug ?? payload.taskId}`,
                }),
            );

            // Wave 3 M2 — dispatch-freeze: resolve the acceptance-check set
            // (Task checks merged over Work defaults) ONCE, right after the
            // claim, and snapshot it onto the run. An in-flight run is graded
            // against what was agreed when it started — later edits to the
            // Task or the Work defaults affect the next run, not this one.
            let gateWork: Awaited<ReturnType<WorkRepository['findById']>> = null;
            let resolvedChecks: TaskAcceptanceCheck[] = [];
            const works = appContext.get(WorkRepository);
            try {
                gateWork = taskRow.workId ? await works.findById(taskRow.workId) : null;
                resolvedChecks = resolveAcceptanceChecks(taskRow, gateWork);
            } catch {
                // Work lookup failed (RPC hiccup). gateWork stays null, so the
                // policy resolves 'off' below and the run proceeds exactly as
                // it did before quality gates existed — fail toward the
                // status quo, never toward a half-resolved gate.
            }
            await bestEffort(() => runs.updateGateResults(claimedRunId, { resolvedChecks }));

            // Wave 2 M3 — worktree-per-Task isolation. Resolves the Work +
            // Task settings and provisions the isolated workspace when (and
            // only when) isolation resolves on; null on the default-off
            // path. Provisioning failure with isolation ON fails the run
            // LOUDLY — the user opted into isolation; silently degrading to
            // a shared checkout would betray that setting.
            let workspaceCwd: string | null = null;
            const taskWorkspace = appContext.get(TaskWorkspaceService);
            let provisioned: Awaited<ReturnType<TaskWorkspaceService['provisionForRun']>> = null;
            try {
                provisioned = await taskWorkspace.provisionForRun({
                    task: taskRow,
                    userId: payload.userId,
                    runId: run.id,
                    agentCanCommit:
                        (agent as { permissions?: { canCommitToRepo?: boolean } }).permissions
                            ?.canCommitToRepo !== false,
                });
                workspaceCwd = provisioned?.cwd ?? null;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await runs.markFailed(run.id, `Workspace provisioning failed: ${message}`);
                await bestEffort(() =>
                    runDenorm.recordTerminal(payload.taskId, claimedRunId, 'failed'),
                );
                await drainWork(taskRow.workId);
                return {
                    status: 'failed',
                    reason: 'workspace-provision-failed',
                    runId: run.id,
                    taskId: payload.taskId,
                };
            }

            // `taskRow` was resolved above (owner-scoped) before any run
            // mutation; it is guaranteed non-null here.
            const immediateInput = taskRow
                ? [
                      `Task ${taskRow.slug ?? taskRow.id}: ${neutralizeControlTokens(taskRow.title)}`,
                      taskRow.description
                          ? `Description: ${neutralizeControlTokens(taskRow.description)}`
                          : null,
                      `Status: ${taskRow.status}`,
                      `Priority: ${taskRow.priority}`,
                      taskRow.labels?.length ? `Labels: ${taskRow.labels.join(', ')}` : null,
                  ]
                      .filter(Boolean)
                      .join('\n')
                : `Task ${payload.taskId}`;

            const result = await runner.execute({
                runId: run.id,
                agentId: agent.id,
                userId: payload.userId,
                kind: 'task',
                signal,
                taskId: payload.taskId,
                immediateInput,
                workspaceCwd,
                scopeContext: taskRow
                    ? `Task scope: mission=${taskRow.missionId ?? 'none'}, idea=${taskRow.ideaId ?? 'none'}, work=${taskRow.workId ?? 'none'}`
                    : null,
            });

            // Wave 3 M3 — the PR gate: "a red check opens no PR". After the
            // agent loop succeeds and BEFORE any terminal bookkeeping or the
            // finalize/PR step, run the dispatch-frozen acceptance checks in
            // the provisioned workspace. Green (or a warn-only policy)
            // proceeds to finalize exactly as before; red under a 'required'
            // policy withholds the PR. One attempt only in M3 — the bounded
            // iterate loop is M5.
            const runSucceeded = result.status === 'assembled' || result.status === 'dispatched';
            const gatePolicy = resolveChecksPolicy(gateWork);
            let gateOutcome: Awaited<ReturnType<TaskGateRunnerService['runChecks']>> | null = null;
            if (provisioned && runSucceeded && gatePolicy !== 'off') {
                const gateRunner = appContext.get(TaskGateRunnerService);
                try {
                    gateOutcome = await gateRunner.runChecks({
                        checks: resolvedChecks,
                        cwd: provisioned.cwd,
                        runId: run.id,
                        policy: gatePolicy,
                    });
                } catch (error) {
                    // A crashed gate step marks the run FAILED, never green —
                    // a gate that did not run must not pass anything.
                    const message = error instanceof Error ? error.message : String(error);
                    await runs.markFailed(run.id, `Quality gate execution failed: ${message}`);
                    await bestEffort(() =>
                        runDenorm.recordTerminal(payload.taskId, claimedRunId, 'failed'),
                    );
                    return {
                        status: 'failed',
                        reason: 'gate-execution-failed',
                        runId: run.id,
                        taskId: payload.taskId,
                    };
                }

                if (gatePolicy === 'required' && gateOutcome.gateStatus !== 'green') {
                    // Red — or 'skipped' when the required policy found zero
                    // checks. Either way: no finalize, no PR. The workspace
                    // and the Task's branchState stay exactly as they are.
                    const requiredFailed = gateOutcome.results.filter((checkResult) => {
                        const check = resolvedChecks.find((c) => c.id === checkResult.id);
                        return checkResult.status !== 'green' && check?.required !== false;
                    });
                    const summary =
                        resolvedChecks.length === 0
                            ? 'Quality gate: no checks configured — PR withheld (checks policy is required).'
                            : `Quality gate red: ${requiredFailed
                                  .map((checkResult) => checkResult.id)
                                  .join(', ')} — PR withheld.`;
                    await runs.markCompleted(run.id, summary);
                    await bestEffort(() =>
                        runDenorm.recordTerminal(payload.taskId, claimedRunId, 'completed'),
                    );
                    // Task chat gets the human-facing breakdown. Plain text —
                    // the chat surface never renders agent messages as markup.
                    const taskChat = appContext.get(TaskChatService);
                    const chatBody =
                        resolvedChecks.length === 0
                            ? 'Quality gate: no checks configured, and this Work requires acceptance checks — no PR was opened. Add checks to the Task or to the Work defaults, then send a message here to re-run.'
                            : [
                                  'Quality gate red — no PR was opened.',
                                  '',
                                  'Failed checks:',
                                  ...requiredFailed.map(
                                      (checkResult) =>
                                          `- ${checkResult.id}: ${
                                              checkResult.status === 'timeout'
                                                  ? 'timed out'
                                                  : checkResult.status === 'error'
                                                    ? 'could not run'
                                                    : `exit code ${checkResult.exitCode}`
                                          }`,
                                  ),
                                  '',
                                  'Fix the issues (or adjust the checks), then send a message here to re-run.',
                              ].join('\n');
                    await bestEffort(() =>
                        taskChat.post(payload.userId, {
                            taskId: payload.taskId,
                            authorType: 'agent',
                            authorId: agent.id,
                            body: chatBody,
                        }),
                    );
                    return {
                        status: 'completed',
                        reason: 'gate-red',
                        agentId: agent.id,
                        taskId: payload.taskId,
                        runId: run.id,
                        dedupKey: payload.dedupKey,
                        gateStatus: gateOutcome.gateStatus,
                    };
                }
            }

            if (result.status === 'assembled') {
                await runs.markCompleted(run.id, `Prompt assembled for task ${payload.taskId}`);
                await bestEffort(() =>
                    runDenorm.recordTerminal(payload.taskId, claimedRunId, 'completed'),
                );
                await drainWork(taskRow.workId);
            } else if (result.status === 'agent-not-found') {
                await runs.markFailed(run.id, 'Agent not found');
                await bestEffort(() =>
                    runDenorm.recordTerminal(payload.taskId, claimedRunId, 'failed'),
                );
                await drainWork(taskRow.workId);
            }

            // Wave 2 M4 — green-path finalize of the isolated workspace:
            // commit + push the run's output, simulate the merge against
            // a FRESH base, then open the PR (→ in_review) or refuse it
            // with NAMED conflict paths (→ blocked). Only runs when a
            // workspace was provisioned and the run itself succeeded.
            if (provisioned && runSucceeded) {
                // Wave 3 M3 — a green gate earns a note on the PR body. Only
                // when EVERY check (required and informational) came back
                // green, so the note can never overstate the verdict.
                const gateNote =
                    gateOutcome &&
                    gateOutcome.gateStatus === 'green' &&
                    gateOutcome.results.length > 0 &&
                    gateOutcome.results.every((checkResult) => checkResult.status === 'green')
                        ? { checksPassed: gateOutcome.results.length }
                        : undefined;
                try {
                    const finalize = await taskWorkspace.finalizeRun({
                        task: taskRow,
                        userId: payload.userId,
                        agentId: agent.id,
                        agentCanOpenPullRequests:
                            (agent as { permissions?: { canOpenPullRequests?: boolean } })
                                .permissions?.canOpenPullRequests !== false,
                        workspace: provisioned,
                        ...(gateNote ? { gate: gateNote } : {}),
                    });
                    return {
                        status: 'completed',
                        agentId: agent.id,
                        taskId: payload.taskId,
                        runId: run.id,
                        dedupKey: payload.dedupKey,
                        workspaceOutcome: finalize.outcome,
                    };
                } catch (error) {
                    // The run executed but its output never landed on the
                    // branch — that IS a failure of the Task's promise.
                    const message = error instanceof Error ? error.message : String(error);
                    await runs.markFailed(run.id, `Workspace finalize failed: ${message}`);
                    await drainWork(taskRow.workId);
                    // Mirror-consistency: for `assembled` runs the row was
                    // already marked completed above, so this markFailed CAS
                    // no-ops — only mirror `failed` when the row could
                    // actually flip (still running, i.e. `dispatched`).
                    if (result.status !== 'assembled') {
                        await bestEffort(() =>
                            runDenorm.recordTerminal(payload.taskId, claimedRunId, 'failed'),
                        );
                    }
                    return {
                        status: 'failed',
                        reason: 'workspace-finalize-failed',
                        runId: run.id,
                        taskId: payload.taskId,
                    };
                }
            }

            return {
                status:
                    result.status === 'assembled' || result.status === 'dispatched'
                        ? 'completed'
                        : result.status,
                agentId: agent.id,
                taskId: payload.taskId,
                runId: run.id,
                dedupKey: payload.dedupKey,
            };
        } finally {
            await appContext.close();
        }
    },
});
