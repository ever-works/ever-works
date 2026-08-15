import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
    tasksAPI,
    type TaskActivityRow,
    type TaskChatMessage,
    type TaskSubtaskRow,
} from '@/lib/api/tasks';
import { agentsAPI } from '@/lib/api/agents';
import { TaskDetailClient } from '@/components/tasks/TaskDetailClient';

function errorMessage(err: unknown, fallback: string): string {
    return err instanceof Error ? err.message : fallback;
}

export async function generateMetadata({
    params,
}: {
    params: Promise<{ id: string }>;
}): Promise<Metadata> {
    const { id } = await params;
    const task = await tasksAPI.get(id);
    return { title: task ? `${task.slug} — ${task.title}` : 'Task' };
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 13.1.
 *
 * `/tasks/[id]` detail page. Server-fetches the Task + initial chat
 * page in parallel; client component handles posting + transitioning.
 * Sectioned scroll layout per spec §6 (no tabs).
 *
 * KbEditor/Tiptap upgrade for the description body lands once the
 * shared editor toolbar is extracted; v1 displays description as
 * plain text with line-break preservation.
 */
export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const task = await tasksAPI.get(id);
    if (!task) notFound();

    const [chatResult, attachmentResult, gateRunResult, subtaskResult, activityResult] =
        await Promise.allSettled([
            tasksAPI.listChat(id, { limit: 50 }),
            // FU-5 — list initial attachments alongside the chat thread so
            // the detail page hydrates in one round-trip and the panel
            // renders without a client-side flash of "no attachments".
            tasksAPI.listAttachments(id),
            // Quality gates (Wave 3 M6) — the Task's runs, newest first.
            // `[0]` carries the gate columns (resolvedChecks / checkResults /
            // gateStatus / gateAttempts) for the Checks section and the run
            // controls; the rest is the Runs history (kanban M7). ONE call
            // for both — they read the same projection, so fetching twice
            // would be pure waste. Best-effort: a miss just renders the
            // pre-dispatch declared checks and no history.
            //
            // 25 (up from 10) now that the Runs section pages its rows in
            // tabs of 7 instead of rendering the whole list — the same page
            // size the Agent Activity feed uses.
            agentsAPI.listSessions({ taskId: id, limit: 25 }),
            // Tasks upgrades — the Subtasks checklist and the per-Task
            // activity feed hydrate with the rest of the page. Both are
            // ONE call each (the API batches the side tables / filters the
            // activity log server-side), and both are best-effort: a miss
            // renders the section empty with an inline error rather than
            // failing the whole Task page.
            tasksAPI.listSubtasks(id),
            tasksAPI.listActivity(id, { limit: 25 }),
        ]);

    const chat =
        chatResult.status === 'fulfilled' ? chatResult.value : { data: [] as TaskChatMessage[] };
    const attachments = attachmentResult.status === 'fulfilled' ? attachmentResult.value : [];
    const runs = gateRunResult.status === 'fulfilled' ? (gateRunResult.value.data ?? []) : [];
    const gateRun = runs[0] ?? null;
    const subtasks =
        subtaskResult.status === 'fulfilled'
            ? subtaskResult.value
            : { data: [] as TaskSubtaskRow[], meta: { total: 0, doneCount: 0 } };
    const activity =
        activityResult.status === 'fulfilled'
            ? activityResult.value
            : { data: [] as TaskActivityRow[], meta: { total: 0 } };

    return (
        <TaskDetailClient
            task={task}
            initialChat={chat.data ?? []}
            initialAttachments={attachments}
            initialGateRun={gateRun}
            initialRuns={runs}
            initialSubtasks={subtasks.data ?? []}
            initialSubtasksMeta={subtasks.meta ?? { total: 0, doneCount: 0 }}
            initialActivity={activity.data ?? []}
            initialActivityTotal={activity.meta?.total ?? 0}
            initialChatError={
                chatResult.status === 'rejected'
                    ? errorMessage(chatResult.reason, 'Failed to load conversation')
                    : null
            }
            initialAttachmentsError={
                attachmentResult.status === 'rejected'
                    ? errorMessage(attachmentResult.reason, 'Failed to load attachments')
                    : null
            }
            initialSubtasksError={
                subtaskResult.status === 'rejected'
                    ? errorMessage(subtaskResult.reason, 'Failed to load sub-tasks')
                    : null
            }
            initialActivityError={
                activityResult.status === 'rejected'
                    ? errorMessage(activityResult.reason, 'Failed to load activity')
                    : null
            }
        />
    );
}
