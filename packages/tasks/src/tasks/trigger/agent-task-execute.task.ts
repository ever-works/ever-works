import { logger as triggerLogger, task } from '@trigger.dev/sdk';
import { NestFactory } from '@nestjs/core';
import type {
    GateVerdict,
    TaskAcceptanceCheck,
    TaskCheckResult,
    TaskGateJudgement,
} from '@ever-works/contracts';
import { AgentRepository, AgentRunRepository, WorkRepository } from '@ever-works/agent/database';
import {
    AgentEscalationService,
    AgentRunService,
    RunDispatchGateService,
    detectDoomLoop,
    fingerprintFailures,
    type DoomLoopVerdict,
    type LoopAttemptSample,
} from '@ever-works/agent/agents';
import { config } from '@ever-works/agent/config';
import {
    resolveAcceptanceChecks,
    resolveAcceptanceCriteria,
    resolveChecksPolicy,
    resolveGateVerdict,
    resolveL0Checks,
    resolveMaxGateAttempts,
    shouldRunGateJudge,
    shouldRunL0PreCheck,
    TaskChatService,
    TaskGateJudgeService,
    TaskGateRunnerService,
    TaskReviewRejectionService,
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
 * Quality gates — the check results that turned the gate red: not-green
 * AND declared required (informational checks report but never block, so
 * they must not drive the iterate loop or the failure summary either).
 */
function filterRequiredGateFailures(
    results: TaskCheckResult[],
    checks: TaskAcceptanceCheck[],
): TaskCheckResult[] {
    return results.filter((checkResult) => {
        const check = checks.find((c) => c.id === checkResult.id);
        return checkResult.status !== 'green' && check?.required !== false;
    });
}

/** Human-readable verdict for one failed check result. */
function describeCheckFailure(checkResult: TaskCheckResult): string {
    return checkResult.status === 'timeout'
        ? 'timed out'
        : checkResult.status === 'error'
          ? 'could not run'
          : `exit code ${checkResult.exitCode}`;
}

/**
 * Quality gates (Wave 3 M5) — compose the iterate message that resumes the
 * agent loop after a red gate: the failing checks' ids, verdicts, and
 * output tails, machine-generated in the same shape as human rejection
 * feedback.
 *
 * Security (prompt-injection hardening): check ids are user-authored and
 * `logTail` is whatever the checked-out repo's build/test output printed —
 * both partially attacker-controlled — and this string becomes the run's
 * `immediateInput`. Every dynamic field is passed through
 * `neutralizeControlTokens` so a crafted chat-template control marker in a
 * test name or build log cannot spoof a system/user turn. Same mechanical
 * strip as Task title/description above: benign content passes unchanged.
 */
function composeGateIterateMessage(input: {
    failing: TaskCheckResult[];
    attempt: number;
    maxAttempts: number;
}): string {
    const lines: string[] = [
        `Quality gate: the task's acceptance checks FAILED (attempt ${input.attempt} of ${input.maxAttempts}).`,
        'Fix the underlying problems in the workspace so every required check passes, then finish. The checks re-run automatically after you are done — do not just claim they pass.',
        '',
        'Failing checks:',
    ];
    for (const checkResult of input.failing) {
        lines.push(
            `- ${neutralizeControlTokens(String(checkResult.id))}: ${describeCheckFailure(checkResult)}`,
        );
        if (checkResult.logTail) {
            lines.push('  Output tail:');
            for (const tailLine of neutralizeControlTokens(checkResult.logTail).split('\n')) {
                lines.push(`    ${tailLine}`);
            }
        }
    }
    return lines.join('\n');
}

/**
 * Judgment layer G2 — compose the iterate message for a JUDGE `retry`.
 *
 * The red-gate message above says "a command failed, here is its output".
 * This one cannot: every command passed. What it has instead is a named
 * list of criteria the judge read as unmet, and it has to be explicit that
 * the checks are NOT the problem — otherwise the agent's obvious next move
 * is to re-run the tests it already passed.
 *
 * Security (prompt-injection hardening): `reason`/`unmet` are model-authored
 * text derived from an attacker-influenced Task description, and this
 * string becomes the run's `immediateInput`. Same mechanical control-token
 * strip as every other dynamic field on this path.
 */
function composeJudgeIterateMessage(input: {
    judgement: TaskGateJudgement;
    attempt: number;
    maxAttempts: number;
}): string {
    const lines: string[] = [
        `Acceptance review: every automated check PASSED, but the task's acceptance criteria are NOT met yet (attempt ${input.attempt} of ${input.maxAttempts}).`,
        'Do not re-run or "fix" the checks — they are green. Close the gaps listed below in the workspace, then finish. The review runs again automatically after you are done.',
        '',
        `Reviewer verdict: ${neutralizeControlTokens(input.judgement.reason || 'acceptance criteria unmet')}`,
    ];
    if (input.judgement.unmet.length > 0) {
        lines.push('', 'Unmet criteria:');
        for (const entry of input.judgement.unmet) {
            lines.push(`- ${neutralizeControlTokens(entry)}`);
        }
    }
    return lines.join('\n');
}

/**
 * Judgment layer G2 — compose the L0 pre-check block prepended to the
 * run's FIRST input.
 *
 * Same shape and the same neutralization as the red-gate iterate message
 * (check ids are user-authored and `logTail` is whatever the checked-out
 * repo printed — both partially attacker-controlled on a prompt path),
 * but the framing is deliberately different: this is context the agent
 * receives BEFORE doing anything, not a verdict on work it already did.
 * Saying "your work failed" about work that has not happened would push
 * the model into re-explaining instead of fixing.
 */
function composeL0PreCheckMessage(failing: TaskCheckResult[]): string {
    const lines: string[] = [
        'Pre-flight check: the workspace ALREADY fails the following fast checks before you have changed anything.',
        'Treat this as the current state of the repository, not as feedback on your work. Fix what is relevant to this task; ignore what is not.',
        '',
        'Failing pre-checks:',
    ];
    for (const checkResult of failing) {
        lines.push(
            `- ${neutralizeControlTokens(String(checkResult.id))}: ${describeCheckFailure(checkResult)}`,
        );
        if (checkResult.logTail) {
            lines.push('  Output tail:');
            for (const tailLine of neutralizeControlTokens(checkResult.logTail).split('\n')) {
                lines.push(`    ${tailLine}`);
            }
        }
    }
    return lines.join('\n');
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
        //
        // `signal` stays in the type but is deliberately NOT destructured: it
        // cannot reach the code that would act on it. `AgentRunService` is a
        // remote proxy in worker scope (see `trigger-internal.module.ts`), so
        // every argument to `runner.execute` is SuperJSON-serialized over HTTP,
        // and SuperJSON has no transformer for `AbortSignal` — it encodes to
        // `{}`, losing even an already-aborted state. Passing it would look
        // like cancellation worked while `signal?.aborted` was permanently
        // `undefined` on the far side. (`createRemoteProxy` now strips signals
        // defensively; this is the call site not pretending in the first place.)
        //
        // Cancellation still works, out of band and API-side:
        // `createAgentRunAbortSource` is built with a `readStatus` reader over
        // `agent_runs.status` and is consulted once per model round-trip, so a
        // run cancelled via `POST /agents/:id/runs/:runId/cancel` stops at the
        // next checkpoint. That DB path is the authoritative one across this
        // boundary — the signal never was.
        { ctx }: { ctx?: { run?: { id?: string } }; signal?: AbortSignal } = {},
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
                // DOCUMENTED dispatch-gate bypass: worker-side bookkeeping
                // for a job the runtime has ALREADY accepted and started.
                // The gate ran at dispatch time
                // (`TaskTransitionService.dispatchAgentRun`, the drain, or
                // assign-task); re-admitting here could only refuse work
                // already in flight and strand it with no run row.
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
                    // Repository registry (Feature G) — lets the provision
                    // spec carry the agent's attached repos (advisory).
                    agentId: payload.agentId,
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

            // Judgment layer G2 — the cheap L0 pre-check. Runs BEFORE the
            // model call, in the provisioned workspace, and only when
            // three things hold: the operator switch is on
            // (`AGENT_GATE_L0_PRECHECK=on`, default OFF), the Work's
            // checks policy is not `off`, and at least one resolved check
            // declares `level: 'L0'`. Its output is prepended to the
            // run's first input through the SAME path the red-gate
            // iterate message uses, so the model reads one consistent
            // format for "here is what the checks say".
            //
            // Never blocking, never persisted: this is context for the
            // prompt, not a verdict on work that has not happened. Any
            // failure here degrades to "no pre-check block", which is
            // exactly the default-off behavior.
            const l0Policy = resolveChecksPolicy(gateWork);
            const l0Checks = resolveL0Checks(resolvedChecks);
            let preCheckBlock: string | null = null;
            if (
                provisioned &&
                shouldRunL0PreCheck({
                    enabled: config.agents.isGateL0PreCheckEnabled(),
                    policy: l0Policy,
                    l0Checks,
                })
            ) {
                try {
                    await bestEffort(() =>
                        runs.updateTelemetry(claimedRunId, {
                            currentActivity: `Running ${l0Checks.length} pre-flight check(s)`,
                        }),
                    );
                    const preCheck = await appContext
                        .get(TaskGateRunnerService)
                        .runPreChecks({ checks: l0Checks, cwd: provisioned.cwd });
                    if (preCheck.failing.length > 0) {
                        preCheckBlock = composeL0PreCheckMessage(preCheck.failing);
                    }
                } catch (error) {
                    // A pre-check that cannot run is a pre-check that
                    // contributes nothing — never a reason to fail a run
                    // the agent has not even started.
                    triggerLogger.warn(
                        `L0 pre-check skipped for run ${claimedRunId}: ${
                            error instanceof Error ? error.message : String(error)
                        }`,
                    );
                }
            }

            // `taskRow` was resolved above (owner-scoped) before any run
            // mutation; it is guaranteed non-null here.
            const taskBrief = taskRow
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
            // G2 — the pre-check block goes AFTER the task brief: the
            // agent should know what it was asked to do before it reads
            // what is already broken. When the pass did not run (the
            // default), `immediateInput` is byte-identical to before.
            const immediateInput = preCheckBlock ? `${taskBrief}\n\n${preCheckBlock}` : taskBrief;

            const scopeContext = taskRow
                ? `Task scope: mission=${taskRow.missionId ?? 'none'}, idea=${taskRow.ideaId ?? 'none'}, work=${taskRow.workId ?? 'none'}`
                : null;
            const result = await runner.execute({
                runId: run.id,
                agentId: agent.id,
                userId: payload.userId,
                kind: 'task',
                // No `signal` — see the note on the `run` params above.
                taskId: payload.taskId,
                immediateInput,
                workspaceCwd,
                scopeContext,
                // Judgment layer G9 — the scope this run was ADMITTED
                // under, snapshotted onto the run row at dispatch. Read
                // from the row we already loaded, so no extra query and
                // nothing rides the queue payload (an old worker
                // re-delivering an old payload could not carry it).
                delegationScope: run.delegationScope ?? null,
            });

            // Wave 3 M3 — the PR gate: "a red check opens no PR". After the
            // agent loop succeeds and BEFORE any terminal bookkeeping or the
            // finalize/PR step, run the dispatch-frozen acceptance checks in
            // the provisioned workspace. Green (or a warn-only policy)
            // proceeds to finalize exactly as before; red under a 'required'
            // policy withholds the PR.
            const runSucceeded = result.status === 'assembled' || result.status === 'dispatched';
            const gatePolicy = resolveChecksPolicy(gateWork);
            let gateOutcome: Awaited<ReturnType<TaskGateRunnerService['runChecks']>> | null = null;
            let gateAttempts = 0;
            // Wave 3 M5 — why the iterate loop stopped before green:
            // 'budget' = the Agent's budget cap was reached between attempts;
            // 'agent-loop' = an iterate attempt's agent loop did not complete
            // (cancelled / budget-blocked inside execute / dispatch failure),
            // so re-running the checks would grade unchanged work.
            // 'loop-detected' = the doom-loop detector (G10) called it: the
            // trail says the next attempt hits the same wall.
            let iterateStop: 'budget' | 'agent-loop' | 'loop-detected' | null = null;
            // Judgment layer G2 — the acceptance-criteria judge's latest
            // opinion, and the verdict it collapses to together with the
            // check results. `null` judgement = no judge ran (the default),
            // which `resolveGateVerdict` maps to the pre-judge behavior.
            let judgement: TaskGateJudgement | null = null;
            let gateVerdict: GateVerdict = 'pass';
            // What the agent says it did — the text the judge grades. Kept
            // in step with the iterate loop so a later attempt is judged on
            // its own summary, not the first attempt's.
            let runSummary = result.outcome?.summary ?? '';
            // Judgment layer G10 — the doom-loop detector's evidence.
            // One sample per COMPLETED gate execution: the normalized
            // fingerprint of what failed, plus whether that attempt made
            // measurable progress (strictly fewer required checks
            // failing than the attempt before it). Both are what
            // separates "retrying and fixing" from "hitting the same
            // wall with the rest of the budget".
            const loopSamples: LoopAttemptSample[] = [];
            let previousFailureCount: number | null = null;
            let loopVerdict: DoomLoopVerdict | null = null;
            const recordLoopSample = (
                outcome: Awaited<ReturnType<TaskGateRunnerService['runChecks']>>,
            ) => {
                const failing = filterRequiredGateFailures(outcome.results, resolvedChecks);
                const progressed =
                    previousFailureCount !== null && failing.length < previousFailureCount;
                previousFailureCount = failing.length;
                loopSamples.push({
                    fingerprint: fingerprintFailures(
                        failing.map((checkResult) => ({
                            id: checkResult.id,
                            outcome: describeCheckFailure(checkResult),
                        })),
                    ),
                    progressed,
                });
            };
            if (provisioned && runSucceeded && gatePolicy !== 'off') {
                const gateRunner = appContext.get(TaskGateRunnerService);
                const maxGateAttempts = resolveMaxGateAttempts(taskRow, gateWork);
                // G2 — dispatch-freeze for the judge, mirroring the check
                // set: the criteria are read ONCE, so an edit mid-run
                // affects the next run and not this one.
                const judgeEnabled = config.agents.isGateJudgeEnabled();
                const criteria = judgeEnabled
                    ? resolveAcceptanceCriteria(taskRow, resolvedChecks)
                    : '';
                /**
                 * Grade one gate outcome with the LLM judge. Returns null —
                 * "no opinion" — whenever the judge is not applicable
                 * (`shouldRunGateJudge`) or the RPC never landed. Both
                 * degrade to exactly the pass/fail gate that shipped
                 * before, which is the whole optionality contract.
                 */
                const runJudge = async (
                    outcome: Awaited<ReturnType<TaskGateRunnerService['runChecks']>>,
                ): Promise<TaskGateJudgement | null> => {
                    if (
                        !shouldRunGateJudge({
                            enabled: judgeEnabled,
                            policy: gatePolicy,
                            gateStatus: outcome.gateStatus,
                            criteria,
                        })
                    ) {
                        return null;
                    }
                    try {
                        await bestEffort(() =>
                            runs.updateTelemetry(claimedRunId, {
                                currentActivity: 'Reviewing output against acceptance criteria',
                            }),
                        );
                        return await appContext.get(TaskGateJudgeService).judge({
                            userId: payload.userId,
                            taskId: payload.taskId,
                            runId: run.id,
                            workId: taskRow.workId ?? null,
                            agentId: agent.id,
                            criteria,
                            output: runSummary,
                            checkResults: outcome.results,
                        });
                    } catch (error) {
                        // The judge is advisory infrastructure. An RPC that
                        // never landed must not convert a green gate into a
                        // withheld PR.
                        triggerLogger.warn(
                            `Gate judge skipped for run ${claimedRunId}: ${
                                error instanceof Error ? error.message : String(error)
                            }`,
                        );
                        return null;
                    }
                };
                try {
                    gateAttempts = 1;
                    gateOutcome = await gateRunner.runChecks({
                        checks: resolvedChecks,
                        cwd: provisioned.cwd,
                        runId: run.id,
                        policy: gatePolicy,
                        attempt: gateAttempts,
                    });
                    judgement = await runJudge(gateOutcome);
                    gateVerdict = resolveGateVerdict({
                        gateStatus: gateOutcome.gateStatus,
                        policy: gatePolicy,
                        judgement,
                        attemptsRemaining: gateAttempts < maxGateAttempts,
                    });
                    recordLoopSample(gateOutcome);

                    // Wave 3 M5 — bounded red → iterate loop. On a red gate
                    // under a 'required' policy the run does not end: the
                    // failing checks (ids + output tails, control-token
                    // neutralized) are fed back to the SAME run's agent loop
                    // as machine-generated rejection feedback, then the
                    // checks re-run — until green, the attempt cap
                    // (`resolveMaxGateAttempts`, clamped 1..5), or the Agent
                    // budget stops it. 'skipped' (zero checks) never
                    // iterates: there is nothing for another attempt to fix.
                    //
                    // Judgment layer G2 — the loop is now driven by the
                    // VERDICT rather than by `gateStatus === 'red'` alone,
                    // so the judge's `retry` feeds this exact loop instead
                    // of inventing a second one. `resolveGateVerdict` only
                    // ever yields 'retry' under a 'required' policy with
                    // attempts left, so the pre-judge entry conditions are
                    // unchanged.
                    while (gateVerdict === 'retry') {
                        // Budget consult between attempts (existing
                        // AgentBudget surface via AgentRunService — RPC).
                        // Only an explicit `allowed: false` stops the loop:
                        // an unreachable budget check falls back to the
                        // attempt cap alone, never to a phantom "over
                        // budget". (`runner.execute` also re-checks the
                        // budget itself at the start of every attempt, so
                        // this is an early-out, not the only enforcement.)
                        try {
                            const budget = await runner.checkBudget(agent);
                            if (budget && budget.allowed === false) {
                                iterateStop = 'budget';
                                break;
                            }
                        } catch {
                            // Budget check unreachable from the worker —
                            // documented fail-open to the loop cap.
                        }

                        // Judgment layer G10 — doom-loop / retry-storm
                        // check, BEFORE spending another agent loop. The
                        // attempt cap alone only bounds how long the
                        // waste lasts; this ends it as soon as the trail
                        // says the next attempt will hit the same wall,
                        // and turns the remaining budget into a human
                        // decision instead of a fifth identical failure.
                        if (config.agents.isRunLoopDetectorEnabled()) {
                            const verdict = detectDoomLoop(loopSamples, {
                                repeatThreshold: config.agents.getRunLoopRepeatThreshold(),
                                maxRetries: config.agents.getRunLoopMaxRetries(),
                            });
                            if (verdict.detected) {
                                loopVerdict = verdict;
                                iterateStop = 'loop-detected';
                                break;
                            }
                        }

                        // G2 — WHICH feedback the agent gets depends on who
                        // asked for the retry. A judge retry means the
                        // commands are green, so replaying the red-gate
                        // message would send the agent to re-run passing
                        // tests instead of closing the named gap.
                        const judgeRetry = judgement?.verdict === 'retry';
                        const iterateMessage = judgeRetry
                            ? composeJudgeIterateMessage({
                                  judgement: judgement as TaskGateJudgement,
                                  attempt: gateAttempts,
                                  maxAttempts: maxGateAttempts,
                              })
                            : composeGateIterateMessage({
                                  failing: filterRequiredGateFailures(
                                      gateOutcome.results,
                                      resolvedChecks,
                                  ),
                                  attempt: gateAttempts,
                                  maxAttempts: maxGateAttempts,
                              });
                        const nextAttempt = gateAttempts + 1;
                        await bestEffort(() =>
                            runs.updateTelemetry(claimedRunId, {
                                currentActivity: judgeRetry
                                    ? `Acceptance criteria unmet — iterating (attempt ${nextAttempt} of ${maxGateAttempts})`
                                    : `Quality gate red — iterating (attempt ${nextAttempt} of ${maxGateAttempts})`,
                            }),
                        );
                        let iterateSucceeded = false;
                        try {
                            const iterateResult = await runner.execute({
                                runId: run.id,
                                agentId: agent.id,
                                userId: payload.userId,
                                kind: 'task',
                                // No `signal` — see the note on the `run` params above.
                                taskId: payload.taskId,
                                immediateInput: iterateMessage,
                                workspaceCwd,
                                scopeContext,
                                // Same scope on the gate-retry iteration:
                                // omitting it here would silently restore
                                // the child's full tool set after the
                                // first failed quality gate.
                                delegationScope: run.delegationScope ?? null,
                            });
                            iterateSucceeded =
                                iterateResult.status === 'assembled' ||
                                iterateResult.status === 'dispatched';
                            // G2 — grade the NEW work, not the old summary.
                            if (iterateSucceeded && iterateResult.outcome?.summary) {
                                runSummary = iterateResult.outcome.summary;
                            }
                        } catch {
                            // An iterate attempt that crashed in transit is
                            // handled like any other incomplete attempt —
                            // the FIRST attempt's verdict already stands and
                            // the red path below reports honestly.
                            iterateSucceeded = false;
                        }
                        if (!iterateSucceeded) {
                            iterateStop = 'agent-loop';
                            break;
                        }
                        // Only a completed agent loop consumes an attempt —
                        // `gateAttempts` counts GATE EXECUTIONS, so the local
                        // counter always matches the persisted
                        // `agent_runs.gateAttempts` the runner writes.
                        gateAttempts = nextAttempt;
                        gateOutcome = await gateRunner.runChecks({
                            checks: resolvedChecks,
                            cwd: provisioned.cwd,
                            runId: run.id,
                            policy: gatePolicy,
                            attempt: gateAttempts,
                        });
                        judgement = await runJudge(gateOutcome);
                        gateVerdict = resolveGateVerdict({
                            gateStatus: gateOutcome.gateStatus,
                            policy: gatePolicy,
                            judgement,
                            attemptsRemaining: gateAttempts < maxGateAttempts,
                        });
                        recordLoopSample(gateOutcome);
                    }
                } catch (error) {
                    // A crashed gate step marks the run FAILED, never green —
                    // a gate that did not run must not pass anything.
                    const message = error instanceof Error ? error.message : String(error);
                    await runs.markFailed(run.id, `Quality gate execution failed: ${message}`);
                    await bestEffort(() =>
                        runDenorm.recordTerminal(payload.taskId, claimedRunId, 'failed'),
                    );
                    // Terminal transition — free the Work's concurrency slot.
                    await drainWork(taskRow.workId);
                    return {
                        status: 'failed',
                        reason: 'gate-execution-failed',
                        runId: run.id,
                        taskId: payload.taskId,
                    };
                }

                // The loop can also exit through a `break` (budget cap, or an
                // iterate attempt whose agent loop never completed), which
                // leaves `gateVerdict` on its now-stale 'retry'. Recompute
                // once with no attempts remaining: a red gate settles to
                // 'fail', unmet criteria to 'escalate', and an already-final
                // verdict is unchanged (the resolver is idempotent for
                // 'pass' / 'fail' / 'escalate').
                gateVerdict = resolveGateVerdict({
                    gateStatus: gateOutcome.gateStatus,
                    policy: gatePolicy,
                    judgement,
                    attemptsRemaining: false,
                });

                if (gateVerdict !== 'pass') {
                    // Red after every allowed attempt — or 'skipped' when the
                    // required policy found zero checks — or (G2) green
                    // checks whose output does not satisfy the Task's
                    // acceptance criteria. Either way: no finalize, no PR.
                    // The workspace and the Task's branchState stay exactly
                    // as they are; a human reply in task chat resumes the
                    // agent, which re-runs the checks.
                    const requiredFailed = filterRequiredGateFailures(
                        gateOutcome.results,
                        resolvedChecks,
                    );
                    // G2 — the judge blocked a gate every command approved.
                    // There is no failing check to name, so the summary,
                    // chat message, escalation reason and durable feedback
                    // all have to say something different.
                    const judgeEscalated = gateVerdict === 'escalate' && judgement !== null;
                    const attemptNoun = gateAttempts === 1 ? 'attempt' : 'attempts';
                    const summary = judgeEscalated
                        ? `Acceptance review after ${gateAttempts} ${attemptNoun}: checks passed but the task's acceptance criteria are unmet — PR withheld.`
                        : resolvedChecks.length === 0
                          ? 'Quality gate: no checks configured — PR withheld (checks policy is required).'
                          : `Quality gate red after ${gateAttempts} ${attemptNoun}: ${requiredFailed
                                .map((checkResult) => checkResult.id)
                                .join(', ')} — PR withheld.`;
                    await runs.markCompleted(run.id, summary);
                    await bestEffort(() =>
                        runDenorm.recordTerminal(payload.taskId, claimedRunId, 'completed'),
                    );
                    // Terminal transition — free the Work's concurrency slot.
                    await drainWork(taskRow.workId);
                    // Task chat gets the human-facing breakdown. Plain text —
                    // the chat surface never renders agent messages as markup.
                    const taskChat = appContext.get(TaskChatService);
                    // Why the loop stopped, in the user's words. Shared by
                    // both bodies below because the reason is orthogonal to
                    // whether it was the judge (G2) or the checks that
                    // rejected the work.
                    const stopNote =
                        iterateStop === 'budget'
                            ? [
                                  '',
                                  "Iteration stopped early: the Agent's budget cap for this period was reached.",
                              ]
                            : iterateStop === 'loop-detected'
                              ? [
                                    '',
                                    `Iteration stopped early: the run was cycling without progress. ${loopVerdict?.reason ?? ''}`.trim(),
                                    'The remaining attempts were NOT spent — they would have hit the same failure.',
                                ]
                              : [];
                    const chatBody = judgeEscalated
                        ? [
                              `Every acceptance check passed, but the acceptance review found the task is not done after ${gateAttempts} ${attemptNoun} — no PR was opened.`,
                              ...stopNote,
                              '',
                              `Reviewer verdict: ${judgement?.reason || 'acceptance criteria unmet'}`,
                              ...(judgement && judgement.unmet.length > 0
                                  ? ['', 'Unmet criteria:', ...judgement.unmet.map((e) => `- ${e}`)]
                                  : []),
                              '',
                              "Close the gaps (or adjust the task's acceptance criteria), then send a message here to re-run.",
                          ].join('\n')
                        : resolvedChecks.length === 0
                          ? 'Quality gate: no checks configured, and this Work requires acceptance checks — no PR was opened. Add checks to the Task or to the Work defaults, then send a message here to re-run.'
                          : [
                                `Quality gate red after ${gateAttempts} ${attemptNoun} — no PR was opened.`,
                                ...stopNote,
                                '',
                                'Failed checks:',
                                ...requiredFailed.map(
                                    (checkResult) =>
                                        `- ${checkResult.id}: ${describeCheckFailure(checkResult)}`,
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

                    // Judgment layer G3 — the agent GAVE UP. Until now this
                    // ended as a chat message and a log line, so "what is
                    // waiting on me?" had no answer. Record the structured
                    // escalation the Task detail + digest read.
                    //
                    // G2 — the judge's `escalate` verdict writes through
                    // THIS service, deliberately: an escalation is already
                    // the platform's answer to "an agent stopped and a human
                    // has to decide", and a judge that invented its own
                    // notification path would be a second inbox nobody
                    // watches.
                    await bestEffort(() =>
                        appContext.get(AgentEscalationService).record({
                            userId: payload.userId,
                            reasonCode:
                                iterateStop === 'budget'
                                    ? 'budget-stop'
                                    : iterateStop === 'loop-detected'
                                      ? 'loop-detected'
                                      : judgeEscalated
                                        ? 'judge-escalated'
                                        : 'gate-exhausted',
                            runId: run.id,
                            taskId: payload.taskId,
                            workId: taskRow.workId ?? null,
                            agentId: agent.id,
                            summary,
                            decisionNeeded: judgeEscalated
                                ? `Every acceptance check passed, but the acceptance review says the task is not done: ${
                                      judgement?.reason || 'the criteria are unmet'
                                  } Decide whether to close the gaps by hand, restate the task's acceptance criteria, or accept the work as-is.`
                                : resolvedChecks.length === 0
                                  ? 'This Work requires acceptance checks but none are configured. Add checks to the Task or the Work defaults, or change the checks policy.'
                                  : iterateStop === 'budget'
                                    ? "The Agent's budget cap stopped the fix loop before the checks went green. Decide whether to raise the budget, fix the failures by hand, or narrow the task."
                                    : 'The agent could not get the required checks green within its attempt budget. Decide whether to fix the failures by hand, adjust the checks, or raise the attempt budget.',
                            attempted: judgeEscalated
                                ? (judgement?.unmet ?? []).map((entry, index) => ({
                                      label: `criterion-${index + 1}`,
                                      outcome: 'unmet',
                                      detail: entry,
                                  }))
                                : requiredFailed.map((checkResult) => ({
                                      label: String(checkResult.id),
                                      outcome: describeCheckFailure(checkResult),
                                      ...(checkResult.logTail
                                          ? { detail: checkResult.logTail }
                                          : {}),
                                  })),
                        }),
                    );
                    // Orchestration M9 — persist the machine feedback so a
                    // LATER resume replays it. The iterate loop already fed
                    // it to the run that was executing, but that run is
                    // terminal now and its context is gone. G2 routes the
                    // judge's feedback through the SAME durable record: a
                    // resumed run must know why the review blocked it, and
                    // there is no failing check to rediscover.
                    const durableFeedback = judgeEscalated
                        ? composeJudgeIterateMessage({
                              judgement: judgement as TaskGateJudgement,
                              attempt: gateAttempts,
                              maxAttempts: gateAttempts,
                          })
                        : requiredFailed.length > 0
                          ? composeGateIterateMessage({
                                failing: requiredFailed,
                                attempt: gateAttempts,
                                maxAttempts: gateAttempts,
                            })
                          : null;
                    if (durableFeedback) {
                        await bestEffort(() =>
                            appContext.get(TaskReviewRejectionService).recordGateRejection({
                                taskId: payload.taskId,
                                workId: taskRow.workId ?? null,
                                runId: run.id,
                                feedback: durableFeedback,
                            }),
                        );
                    }

                    return {
                        status: 'completed',
                        reason: judgeEscalated ? 'gate-judge-escalated' : 'gate-red',
                        agentId: agent.id,
                        taskId: payload.taskId,
                        runId: run.id,
                        dedupKey: payload.dedupKey,
                        gateStatus: gateOutcome.gateStatus,
                        // Additive: the pass/fail gate had no verdict to
                        // report, so nothing downstream reads this yet.
                        gateVerdict,
                        gateAttempts,
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
            } else if (result.status === 'interrupted') {
                // Run steering (Wave 4 M5) — a human stopped the loop between
                // iterations. `AgentRunService.finalize` already marked the row
                // `completed` with a summary, so NO status write here; what is
                // still owed is the bookkeeping every other terminal path does:
                // mirror the board chip off "running", and free the Work's
                // concurrency slot. `runSucceeded` is false for this status, so
                // the gate and the PR step below are skipped by construction —
                // an interrupted run must not be graded or shipped.
                await bestEffort(() =>
                    runDenorm.recordTerminal(payload.taskId, claimedRunId, 'completed'),
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
                        // Run telemetry — lets finalize stamp
                        // `agent_runs.changedFilesCount` for the board chip
                        // + Sessions cockpit (best-effort inside).
                        runId: claimedRunId,
                        agentCanOpenPullRequests:
                            (agent as { permissions?: { canOpenPullRequests?: boolean } })
                                .permissions?.canOpenPullRequests !== false,
                        workspace: provisioned,
                        ...(gateNote ? { gate: gateNote } : {}),
                        // Merge-policy matrix (Wave 3, D4) — the run's REAL
                        // gate verdict feeds `requireGreenGate` at the merge
                        // decision point. `gateNote` above is deliberately
                        // narrower (fully-green only, PR-body prose); a
                        // 'warn' Work reaches finalize with a red gate and
                        // the merge decision has to see that, not a
                        // prettified version of it. `null` when the gate
                        // never ran, which a requireGreenGate policy refuses.
                        gateStatus: gateOutcome?.gateStatus ?? null,
                    });
                    return {
                        status: 'completed',
                        agentId: agent.id,
                        taskId: payload.taskId,
                        runId: run.id,
                        dedupKey: payload.dedupKey,
                        workspaceOutcome: finalize.outcome,
                        // Additive: absent unless an operator opted into
                        // agent merges for this scope.
                        ...(finalize.merge ? { mergeOutcome: finalize.merge } : {}),
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
