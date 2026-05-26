import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { tasksAPI, type TaskChatMessage } from '@/lib/api/tasks';
import { TaskDetailClient } from '@/components/tasks/TaskDetailClient';

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
    const [task, chat] = await Promise.all([
        tasksAPI.get(id),
        tasksAPI.listChat(id, { limit: 50 }).catch(() => ({ data: [] as TaskChatMessage[] })),
    ]);
    if (!task) notFound();

    return <TaskDetailClient task={task} initialChat={chat.data ?? []} />;
}
