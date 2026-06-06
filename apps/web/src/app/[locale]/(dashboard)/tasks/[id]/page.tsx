import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { tasksAPI, type TaskChatMessage } from '@/lib/api/tasks';
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

    const [chatResult, attachmentResult] = await Promise.allSettled([
        tasksAPI.listChat(id, { limit: 50 }),
        // FU-5 — list initial attachments alongside the chat thread so
        // the detail page hydrates in one round-trip and the panel
        // renders without a client-side flash of "no attachments".
        tasksAPI.listAttachments(id),
    ]);

    const chat =
        chatResult.status === 'fulfilled' ? chatResult.value : { data: [] as TaskChatMessage[] };
    const attachments = attachmentResult.status === 'fulfilled' ? attachmentResult.value : [];

    return (
        <TaskDetailClient
            task={task}
            initialChat={chat.data ?? []}
            initialAttachments={attachments}
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
        />
    );
}
