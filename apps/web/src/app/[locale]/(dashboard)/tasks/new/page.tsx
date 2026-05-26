import type { Metadata } from 'next';
import { NewTaskForm } from '@/components/tasks/NewTaskForm';
import { createTaskAction } from '@/app/actions/tasks';

export const metadata: Metadata = {
    title: 'New Task',
};

/**
 * Agents/Skills/Tasks PR #1017 — Phase 12.7. Simple create form.
 * Scope picker (Mission / Idea / Work) lands in a follow-up tick.
 */
export default function NewTaskPage() {
    return <NewTaskForm createTask={createTaskAction} />;
}
