'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { Task, TaskChatMessage, TaskStatus } from '@/lib/api/tasks';
import { postTaskChatAction, transitionTaskAction } from '@/app/actions/tasks';
import { TaskRecurringSection } from './TaskRecurringSection';

const STATUS_TONES: Record<TaskStatus, string> = {
    backlog: 'bg-surface-secondary text-text-secondary',
    todo: 'bg-info/10 text-info',
    in_progress: 'bg-warning/10 text-warning',
    in_review: 'bg-warning/10 text-warning',
    blocked: 'bg-danger/10 text-danger',
    done: 'bg-success/10 text-success',
    cancelled: 'bg-text-muted/10 text-text-muted',
};

const NEXT_STATUS: Record<TaskStatus, TaskStatus[]> = {
    backlog: ['todo', 'cancelled'],
    todo: ['in_progress', 'blocked', 'cancelled'],
    in_progress: ['in_review', 'blocked', 'done', 'cancelled'],
    in_review: ['in_progress', 'blocked', 'done', 'cancelled'],
    blocked: ['todo', 'in_progress', 'cancelled'],
    done: ['in_progress'],
    cancelled: [],
};

/**
 * Agents/Skills/Tasks PR #1017 — Phase 13.3 client.
 *
 * Sectioned-scroll detail layout per spec §6. Sections: header,
 * description, members + transitions, chat thread, posting box.
 *
 * The chat panel is a plain textarea for v1; mention picker +
 * Tiptap-lite editor + KB wikilink autocomplete land in a follow-up
 * sub-tick once the shared chat-input primitive is extracted from
 * the AI chat surface.
 */
export function TaskDetailClient({
    task,
    initialChat,
}: {
    task: Task;
    initialChat: TaskChatMessage[];
}) {
    const [messages, setMessages] = useState(initialChat);
    const [currentStatus, setCurrentStatus] = useState<TaskStatus>(task.status);
    const [draft, setDraft] = useState('');
    const [pendingPost, startPost] = useTransition();
    const [pendingTransition, startTransition] = useTransition();
    const [postError, setPostError] = useState<string | null>(null);
    const [transitionError, setTransitionError] = useState<string | null>(null);

    const handlePost = (e: React.FormEvent) => {
        e.preventDefault();
        if (!draft.trim()) return;
        setPostError(null);
        startPost(() => {
            void (async () => {
                try {
                    const message = await postTaskChatAction(task.id, draft.trim());
                    setMessages((prev) => [...prev, message]);
                    setDraft('');
                } catch (err) {
                    setPostError(err instanceof Error ? err.message : 'Failed to post');
                }
            })();
        });
    };

    const handleTransition = (to: TaskStatus) => {
        setTransitionError(null);
        startTransition(() => {
            void (async () => {
                try {
                    const updated = await transitionTaskAction(task.id, to);
                    setCurrentStatus(updated.status);
                } catch (err) {
                    setTransitionError(err instanceof Error ? err.message : 'Transition failed');
                }
            })();
        });
    };

    return (
        <div className="max-w-screen-2xl mx-auto p-6 space-y-6">
            <div>
                <Link
                    href={ROUTES.DASHBOARD_TASKS}
                    className="text-xs text-text-muted hover:text-text"
                >
                    ← Tasks
                </Link>
            </div>
            <header className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <div className="flex items-center gap-2 text-[11px] font-mono text-text-muted">
                    <span>{task.slug}</span>
                    <span>·</span>
                    <span
                        className={`uppercase tracking-wide px-1.5 py-0.5 rounded ${STATUS_TONES[currentStatus]}`}
                    >
                        {currentStatus.replace('_', ' ')}
                    </span>
                    <span>·</span>
                    <span className="uppercase">{task.priority}</span>
                </div>
                <h1 className="text-2xl font-semibold text-text dark:text-text-dark mt-2">
                    {task.title}
                </h1>
                {task.description && (
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-3 whitespace-pre-wrap">
                        {task.description}
                    </p>
                )}
                {(task.labels ?? []).length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {(task.labels ?? []).map((l) => (
                            <span
                                key={l}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary"
                            >
                                {l}
                            </span>
                        ))}
                    </div>
                )}
            </header>

            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <h2 className="text-sm font-medium text-text dark:text-text-dark mb-3">Move to</h2>
                <div className="flex flex-wrap gap-2">
                    {(NEXT_STATUS[currentStatus] ?? []).map((next) => (
                        <Button
                            key={next}
                            size="sm"
                            variant="ghost"
                            disabled={pendingTransition}
                            onClick={() => handleTransition(next)}
                            className="text-xs"
                        >
                            {next.replace('_', ' ')}
                        </Button>
                    ))}
                    {(NEXT_STATUS[currentStatus] ?? []).length === 0 && (
                        <span className="text-xs text-text-muted">No transitions available.</span>
                    )}
                </div>
                {transitionError && (
                    <p className="text-xs text-danger mt-2" role="alert">
                        {transitionError}
                    </p>
                )}
            </section>

            {/* Phase 17.8 UI — Recurring template controls. Sits
                between transitions and conversation so it's
                discoverable without dominating the page. */}
            <TaskRecurringSection task={task} />

            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                <h2 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                    Conversation
                </h2>
                {messages.length === 0 ? (
                    <p className="text-xs text-text-muted">No messages yet.</p>
                ) : (
                    <ul className="space-y-3">
                        {messages.map((m) => (
                            <li
                                key={m.id}
                                className="rounded-lg border border-border/40 dark:border-border-dark/40 p-3"
                            >
                                <div className="flex items-center justify-between gap-2 text-[11px] text-text-muted">
                                    <span>
                                        {m.authorType === 'agent' ? '🤖' : '👤'}{' '}
                                        <span className="font-mono">{m.authorId.slice(0, 8)}…</span>
                                    </span>
                                    <span>
                                        {new Date(m.createdAt).toLocaleString()}
                                        {m.editedAt && ' · edited'}
                                    </span>
                                </div>
                                <p className="text-sm text-text dark:text-text-dark mt-1 whitespace-pre-wrap">
                                    {m.body}
                                </p>
                                {(m.mentions ?? []).length > 0 && (
                                    <div className="mt-2 flex flex-wrap gap-1">
                                        {(m.mentions ?? []).map((mention, i) => (
                                            <span
                                                key={i}
                                                className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary"
                                            >
                                                {mention.type === 'kb' ? '[[' : '@'}
                                                {mention.slug ?? mention.id}
                                                {mention.type === 'kb' ? ']]' : ''}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ul>
                )}

                <form onSubmit={handlePost} className="mt-4 space-y-2">
                    <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={3}
                        placeholder="Write a message. Use @agent-slug to ping an Agent."
                        className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3 text-sm text-text dark:text-text-dark"
                    />
                    {postError && (
                        <p className="text-xs text-danger" role="alert">
                            {postError}
                        </p>
                    )}
                    <div className="flex justify-end">
                        <Button type="submit" size="sm" disabled={pendingPost || !draft.trim()}>
                            {pendingPost ? '…' : 'Post'}
                        </Button>
                    </div>
                </form>
            </section>
        </div>
    );
}
