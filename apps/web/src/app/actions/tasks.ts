'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { DecisionConflictReportDto, TaskAcceptanceCheck } from '@ever-works/contracts';
import {
    tasksAPI,
    type ListTasksQuery,
    type RunBatchItemResult,
    type RunCandidateAgent,
    type RunTaskResult,
    type Task,
    type TaskChatMessage,
    type TaskDiff,
    type TaskPriority,
    type TaskPrStatus,
    type TaskStatus,
} from '@/lib/api/tasks';
import { ApiResponseError } from '@/lib/api/server-api';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

export async function createTaskAction(input: {
    title: string;
    description?: string | null;
    priority?: TaskPriority;
    labels?: string[];
    missionId?: string | null;
    ideaId?: string | null;
    workId?: string | null;
    parentTaskId?: string | null;
    /** Quality gates (Wave 3 M6) — acceptance checks declared at create. */
    acceptanceChecks?: TaskAcceptanceCheck[] | null;
    maxGateAttempts?: number | null;
}): Promise<Task> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const task = await tasksAPI.create(input);
    revalidatePath('/tasks');
    return task;
}

export async function updateTaskAction(
    id: string,
    patch: Partial<
        Pick<
            Task,
            | 'title'
            | 'description'
            | 'priority'
            | 'labels'
            | 'parentTaskId'
            | 'requireAllApprovers'
            | 'isolationMode'
            | 'acceptanceChecks'
            | 'maxGateAttempts'
        >
    >,
): Promise<Task> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const task = await tasksAPI.update(id, patch);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}

export async function deleteTaskAction(id: string): Promise<{ deleted: true }> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const res = await tasksAPI.remove(id);
    revalidatePath('/tasks');
    return res;
}

export async function transitionTaskAction(
    id: string,
    to: TaskStatus,
    force = false,
): Promise<Task> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const task = await tasksAPI.transition(id, to, force);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}

/**
 * Kanban run cockpit (Wave 2) — read-only refresh used by the board's
 * run-chip polling hook. Re-fetches the user's tasks WITH the latest-run
 * embed (`includeRun=true`); the client merges run data by task id, so a
 * plain, filter-free page (bounded limit) is sufficient. No
 * revalidatePath on purpose — this is a poll, not a mutation.
 */
export async function listTasksWithRunsAction(
    query: Omit<ListTasksQuery, 'includeRun'> = {},
): Promise<Task[]> {
    // Security: verify session server-side before reading data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const result = await tasksAPI.list({
        ...query,
        limit: Math.min(200, query.limit ?? 200),
        includeRun: true,
    });
    return result.data;
}

// ── Board dispatch (kanban M3 / M4) ───────────────────────────────

/**
 * Result of a board "Run".
 *
 * A DISCRIMINATED UNION rather than a thrown error on purpose: Next
 * redacts thrown Server-Action messages in production, so a UI that
 * branched on `err.message` would work in dev and silently do nothing in
 * prod. Every outcome the board reacts to — pick an agent, point at the
 * live run, report a park — travels in the return value.
 */
export type RunTaskActionResult =
    | { ok: true; run: RunTaskResult }
    | {
          ok: false;
          /** Machine code; `RUN_*` for the handled cases, `RUN_FAILED` otherwise. */
          code: string;
          message: string;
          /** Present on RUN_AGENT_AMBIGUOUS / RUN_NO_AGENT — feeds the picker. */
          candidates?: RunCandidateAgent[];
          /** Present on RUN_ALREADY_IN_FLIGHT. */
          runId?: string;
      };

function toRunFailure(err: unknown): RunTaskActionResult {
    if (err instanceof ApiResponseError) {
        const details = (err.details ?? {}) as {
            candidates?: RunCandidateAgent[];
            runId?: string;
        };
        return {
            ok: false,
            code: err.code ?? 'RUN_FAILED',
            message: err.message,
            ...(Array.isArray(details.candidates) ? { candidates: details.candidates } : {}),
            ...(typeof details.runId === 'string' ? { runId: details.runId } : {}),
        };
    }
    return {
        ok: false,
        code: 'RUN_FAILED',
        message: err instanceof Error ? err.message : String(err),
    };
}

/**
 * Board dispatch (kanban M3) — run a Task now. `agentId` omitted lets
 * the server resolve it; an ambiguous or empty resolution comes back as
 * `RUN_AGENT_AMBIGUOUS` / `RUN_NO_AGENT` with the candidate list, which
 * is what opens the agent picker.
 */
export async function runTaskAction(
    id: string,
    agentId?: string | null,
): Promise<RunTaskActionResult> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    try {
        const run = await tasksAPI.run(id, agentId ?? null);
        revalidatePath('/tasks');
        revalidatePath(`/tasks/${id}`);
        return { ok: true, run };
    } catch (err) {
        return toRunFailure(err);
    }
}

/** Board dispatch — the agent picker's option list for one Task. */
export async function listTaskRunCandidatesAction(id: string): Promise<RunCandidateAgent[]> {
    // Security: verify session server-side before reading data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const result = await tasksAPI.listRunCandidates(id);
    return result.data ?? [];
}

/**
 * Board dispatch (kanban M4) — the column "Run all" affordance. Per-item
 * results: one Task without an agent never stops the rest of the column.
 */
export async function runTasksBatchAction(
    items: { taskId: string; agentId?: string | null }[],
): Promise<{ results: RunBatchItemResult[] }> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    if (items.length === 0) return { results: [] };
    try {
        const result = await tasksAPI.runBatch(items);
        revalidatePath('/tasks');
        return result;
    } catch (err) {
        // A whole-request failure (validation, auth, transport) is
        // reported per item so the caller has exactly one result shape.
        const failure = toRunFailure(err);
        return {
            results: items.map((item) => ({
                taskId: item.taskId,
                ok: false as const,
                error: {
                    code: failure.ok ? 'RUN_FAILED' : failure.code,
                    message: failure.ok ? '' : failure.message,
                },
            })),
        };
    }
}

// ── PR insights (kanban M5 / M6) ──────────────────────────────────

/**
 * The board's review pill data for one Task.
 *
 * Read-only, so no `revalidatePath`. NEVER throws: the pill is a
 * decoration on a card, and a provider hiccup must not blank the board —
 * a failed read degrades to `null` (no pill) exactly like a Task that
 * has no PR. Server-Action prod-redaction rule: the caller gets a value
 * or `null`, never a message it would have to branch on.
 */
export async function getTaskPrStatusAction(
    id: string,
    opts: { refresh?: boolean } = {},
): Promise<TaskPrStatus | null> {
    // Security: verify session server-side before reading data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    try {
        return await tasksAPI.prStatus(id, opts);
    } catch {
        return null;
    }
}

/**
 * Capped diff for the board's diff sheet.
 *
 * Discriminated union rather than a throw: the sheet has real,
 * user-actionable failure states (no branch yet → 404; git provider not
 * connected or without the capability → 409) and the production build
 * redacts thrown Server-Action messages, so branching on `err.message`
 * would silently do nothing once deployed (MEMORY bug class).
 */
export type TaskDiffActionResult =
    | { ok: true; data: TaskDiff }
    | { ok: false; code: 'NOT_FOUND' | 'PROVIDER_UNAVAILABLE' | 'DIFF_FAILED' };

export async function getTaskDiffAction(
    id: string,
    opts: { maxFiles?: number; maxBytes?: number } = {},
): Promise<TaskDiffActionResult> {
    // Security: verify session server-side before reading data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    try {
        return { ok: true, data: await tasksAPI.diff(id, opts) };
    } catch (err) {
        if (err instanceof ApiResponseError) {
            if (err.statusCode === 404) return { ok: false, code: 'NOT_FOUND' };
            if (err.statusCode === 409) return { ok: false, code: 'PROVIDER_UNAVAILABLE' };
        }
        return { ok: false, code: 'DIFF_FAILED' };
    }
}

/**
 * Re-litigation guard (memory upgrades M6) — fetch the settled decisions
 * this Task appears to re-open.
 *
 * Read-only, so no `revalidatePath`. Deliberately NEVER throws: the guard
 * is advisory and a failure to compute it must not degrade the Task
 * surface, so a failed read degrades to "no conflicts".
 */
export async function getTaskDecisionConflictsAction(
    id: string,
): Promise<DecisionConflictReportDto> {
    // Security: verify session server-side before reading data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    try {
        return await tasksAPI.decisionConflicts(id);
    } catch (error) {
        console.error('[tasks] decision-conflict check failed:', error);
        return { conflicts: [], scanned: 0, heuristic: 'unavailable' };
    }
}

/**
 * Wave 2 M7 — re-run the Task agent to resolve a workspace merge
 * conflict. The API answers 409 when the branch is not in a conflict
 * state; the resulting error message is surfaced to the caller.
 */
export async function resolveTaskConflictsAction(id: string): Promise<Task> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const task = await tasksAPI.resolveConflicts(id);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}

/**
 * Wave 2 M7 — delete the Task branch and reset its workspace
 * identity. Irreversible; the UI confirms before calling this.
 */
export async function discardTaskBranchAction(id: string): Promise<{ ok: true }> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const res = await tasksAPI.discardBranch(id);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return res;
}

export async function postTaskChatAction(taskId: string, body: string): Promise<TaskChatMessage> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const message = await tasksAPI.postChat(taskId, body);
    revalidatePath(`/tasks/${taskId}`);
    return message;
}

export async function editTaskChatAction(
    messageId: string,
    body: string,
): Promise<TaskChatMessage> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    return tasksAPI.editChat(messageId, body);
}

/**
 * Phase 17.8 UI — promote a Task to a recurring template. The
 * service-layer validates the RRULE and computes the first
 * `nextOccurrenceAt`; the dispatcher (`task-recurrence-dispatcher`)
 * spawns instances on schedule.
 */
export async function setTaskRecurringAction(
    id: string,
    input: {
        recurrenceRule: string;
        recurrenceTimezone?: string;
        recurrenceEndsAt?: string;
        recurrenceMaxOccurrences?: number;
    },
): Promise<Task> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const task = await tasksAPI.setRecurring(id, input);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}

/**
 * Phase 17.8 UI — demote a recurring template back to a plain
 * Task. Existing spawned instances are NOT cascaded — they keep
 * their `parentRecurringTaskId` pointer and continue to live as
 * independent rows.
 */
export async function clearTaskRecurringAction(id: string): Promise<Task> {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const task = await tasksAPI.clearRecurring(id);
    revalidatePath('/tasks');
    revalidatePath(`/tasks/${id}`);
    return task;
}

// FU-5 — attachment server actions. The actual upload (multipart →
// /api/uploads) happens client-side via the proxy route at
// `apps/web/src/app/api/uploads/route.ts`; once the client has the
// returned uploadId, it calls `attachUploadAction` to wire it into the
// Task via the existing `POST /api/tasks/:id/attachments` endpoint.

export async function attachUploadAction(taskId: string, uploadId: string) {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const row = await tasksAPI.addAttachment(taskId, uploadId);
    revalidatePath(`/tasks/${taskId}`);
    return row;
}

export async function detachAttachmentAction(taskId: string, attachmentId: string) {
    // Security: verify session server-side before mutating data
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);

    const res = await tasksAPI.removeAttachment(taskId, attachmentId);
    revalidatePath(`/tasks/${taskId}`);
    return res;
}
