'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Loader2, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type {
    Task,
    TaskAttachmentRow,
    TaskChatMessage,
    TaskPriority,
    TaskStatus,
} from '@/lib/api/tasks';
import { postTaskChatAction, transitionTaskAction, updateTaskAction } from '@/app/actions/tasks';
import { TaskRecurringSection } from './TaskRecurringSection';
import { TaskAttachmentsSection } from './TaskAttachmentsSection';

// Status tones + dots mirror /tasks (TasksList) so colours stay
// consistent across the list filter and the detail workflow buttons.
const STATUS_TONES: Record<TaskStatus, string> = {
    backlog: 'bg-surface-secondary text-text-secondary',
    todo: 'bg-info/10 text-info',
    in_progress: 'bg-warning/10 text-warning',
    in_review: 'bg-warning/10 text-warning',
    blocked: 'bg-danger/10 text-danger',
    done: 'bg-success/10 text-success',
    cancelled: 'bg-text-muted/10 text-text-muted',
};

const STATUS_DOT: Record<TaskStatus, string> = {
    backlog: 'bg-slate-400',
    todo: 'bg-info',
    in_progress: 'bg-warning',
    in_review: 'bg-violet-500',
    blocked: 'bg-danger',
    done: 'bg-success',
    cancelled: 'bg-text-muted',
};

const ALL_STATUSES: TaskStatus[] = [
    'backlog',
    'todo',
    'in_progress',
    'in_review',
    'blocked',
    'done',
    'cancelled',
];

const NEXT_STATUS: Record<TaskStatus, TaskStatus[]> = {
    backlog: ['todo', 'cancelled'],
    todo: ['in_progress', 'blocked', 'cancelled'],
    in_progress: ['in_review', 'blocked', 'done', 'cancelled'],
    in_review: ['in_progress', 'blocked', 'done', 'cancelled'],
    blocked: ['todo', 'in_progress', 'cancelled'],
    done: ['in_progress'],
    cancelled: [],
};

// Priority metadata — JIRA-style labelled, colour-coded chips so a
// bare "p3" reads as a meaningful "Normal" with the right tone.
const PRIORITY_META: Record<TaskPriority, { label: string; dot: string; tone: string }> = {
    p0: { label: 'Urgent', dot: 'bg-danger', tone: 'text-danger' },
    p1: { label: 'High', dot: 'bg-warning', tone: 'text-warning' },
    p2: { label: 'Medium', dot: 'bg-amber-500', tone: 'text-amber-600 dark:text-amber-400' },
    p3: { label: 'Normal', dot: 'bg-info', tone: 'text-info' },
    p4: { label: 'Low', dot: 'bg-text-muted', tone: 'text-text-muted' },
};

function formatDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium' });
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 13.3 client.
 *
 * JIRA-style two-column issue view: the main column holds the title,
 * status action, description, attachments, and activity thread; the
 * right rail is a sticky "Details" panel (status, priority, labels,
 * dates, scope) plus the recurring-schedule controls.
 *
 * The chat panel is a plain textarea for v1; mention picker +
 * Tiptap-lite editor + KB wikilink autocomplete land in a follow-up
 * sub-tick once the shared chat-input primitive is extracted from
 * the AI chat surface.
 */
export function TaskDetailClient({
    task,
    initialChat,
    initialAttachments = [],
    initialChatError = null,
    initialAttachmentsError = null,
}: {
    task: Task;
    initialChat: TaskChatMessage[];
    initialAttachments?: TaskAttachmentRow[];
    initialChatError?: string | null;
    initialAttachmentsError?: string | null;
}) {
    const t = useTranslations('dashboard.tasksPage.detail');
    const tStatus = useTranslations('dashboard.tasksPage.status');
    const [messages, setMessages] = useState(initialChat);
    const [currentStatus, setCurrentStatus] = useState<TaskStatus>(task.status);
    const [draft, setDraft] = useState('');
    const [pendingPost, startPost] = useTransition();
    const [pendingTransition, startTransition] = useTransition();
    const [postError, setPostError] = useState<string | null>(null);
    const [transitionError, setTransitionError] = useState<string | null>(null);
    const [description, setDescription] = useState(task.description ?? '');
    const [editingDesc, setEditingDesc] = useState(false);
    const [descDraft, setDescDraft] = useState(task.description ?? '');
    const [pendingDesc, startDesc] = useTransition();
    const [descError, setDescError] = useState<string | null>(null);

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
        if (to === currentStatus) return;
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

    const handleSaveDescription = () => {
        setDescError(null);
        startDesc(() => {
            void (async () => {
                try {
                    const updated = await updateTaskAction(task.id, {
                        description: descDraft.trim() || null,
                    });
                    setDescription(updated.description ?? '');
                    setEditingDesc(false);
                } catch (err) {
                    setDescError(
                        err instanceof Error ? err.message : 'Failed to save description',
                    );
                }
            })();
        });
    };

    // Statuses reachable from the current one — drives which workflow
    // buttons are clickable vs. shown disabled.
    const allowedNext = new Set(NEXT_STATUS[currentStatus] ?? []);
    const labels = task.labels ?? [];
    const priority = PRIORITY_META[task.priority];
    const scope = task.workId
        ? { label: 'Work', id: task.workId }
        : task.missionId
          ? { label: 'Mission', id: task.missionId }
          : task.ideaId
            ? { label: 'Idea', id: task.ideaId }
            : null;

    return (
        <div className="max-w-screen-xl mx-auto p-6">
            <div className="mb-4">
                <Link
                    href={ROUTES.DASHBOARD_TASKS}
                    className="inline-flex items-center gap-1.5 text-xs text-text-muted hover:text-text dark:hover:text-text-dark transition-colors"
                >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    Tasks
                </Link>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* ---- Main column ---------------------------------------- */}
                <div className="lg:col-span-2 space-y-6">
                    {/* Title + status action */}
                    <div>
                        <div className="text-[11px] font-mono text-text-muted mb-1.5">
                            {task.slug}
                        </div>
                        <h1 className="text-2xl font-semibold leading-tight text-text dark:text-text-dark">
                            {task.title}
                        </h1>
                        {/* JIRA-style workflow buttons — mirrors the status
                            pills on /tasks. Current status shows active in its
                            own colour; allowed transitions are clickable; the
                            rest are disabled so the state machine stays honest. */}
                        <div className="mt-3 flex flex-wrap items-center gap-1.5">
                            {ALL_STATUSES.map((s) => {
                                const isCurrent = s === currentStatus;
                                const isAllowed = allowedNext.has(s);
                                const disabled = pendingTransition || (!isCurrent && !isAllowed);
                                return (
                                    <button
                                        key={s}
                                        type="button"
                                        disabled={disabled}
                                        aria-current={isCurrent}
                                        onClick={() => {
                                            if (!isCurrent && isAllowed) handleTransition(s);
                                        }}
                                        className={cn(
                                            'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded border whitespace-nowrap transition-colors',
                                            isCurrent
                                                ? cn(
                                                      STATUS_TONES[s],
                                                      'border-current/30 ring-1 ring-current/20 cursor-default',
                                                  )
                                                : isAllowed
                                                  ? 'border-border/60 dark:border-border-dark/60 text-text-secondary dark:text-text-secondary-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark hover:text-text dark:hover:text-text-dark'
                                                  : 'border-border/40 dark:border-border-dark/40 text-text-muted/50 dark:text-text-muted-dark/50 cursor-not-allowed',
                                        )}
                                    >
                                        <span
                                            className={cn(
                                                'w-1.5 h-1.5 rounded-full shrink-0',
                                                STATUS_DOT[s],
                                                !isCurrent && !isAllowed && 'opacity-50',
                                            )}
                                        />
                                        {tStatus(s)}
                                    </button>
                                );
                            })}
                            {pendingTransition && (
                                <Loader2 className="w-4 h-4 animate-spin text-text-muted ml-1" />
                            )}
                        </div>
                        {transitionError && (
                            <p className="text-xs text-danger mt-2" role="alert">
                                {transitionError}
                            </p>
                        )}
                    </div>

                    {/* Description — inline editable, saves via updateTaskAction. */}
                    <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                        <div className="flex items-center justify-between mb-3">
                            <h2 className="text-sm font-medium text-text dark:text-text-dark">
                                Description
                            </h2>
                            {!editingDesc && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs gap-1.5"
                                    onClick={() => {
                                        setDescDraft(description);
                                        setDescError(null);
                                        setEditingDesc(true);
                                    }}
                                >
                                    <Pencil className="w-3.5 h-3.5" />
                                    Edit
                                </Button>
                            )}
                        </div>
                        {editingDesc ? (
                            <div className="space-y-2">
                                <textarea
                                    value={descDraft}
                                    onChange={(e) => setDescDraft(e.target.value)}
                                    rows={6}
                                    autoFocus
                                    placeholder="Add a description…"
                                    className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3 text-sm leading-relaxed text-text dark:text-text-dark"
                                />
                                {descError && (
                                    <p className="text-xs text-danger" role="alert">
                                        {descError}
                                    </p>
                                )}
                                <div className="flex justify-end gap-2">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        disabled={pendingDesc}
                                        onClick={() => {
                                            setEditingDesc(false);
                                            setDescError(null);
                                        }}
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        disabled={pendingDesc}
                                        onClick={handleSaveDescription}
                                    >
                                        {pendingDesc ? '…' : 'Save'}
                                    </Button>
                                </div>
                            </div>
                        ) : description ? (
                            <p className="text-sm leading-relaxed text-text-secondary dark:text-text-secondary-dark whitespace-pre-wrap">
                                {description}
                            </p>
                        ) : (
                            <p className="text-sm text-text-muted italic">No description provided.</p>
                        )}
                    </section>

                    {/* FU-5 — Attachments */}
                    <TaskAttachmentsSection
                        taskId={task.id}
                        workId={task.workId}
                        initial={initialAttachments}
                        initialError={initialAttachmentsError}
                    />

                    {/* Activity / conversation */}
                    <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                        <h2 className="text-sm font-medium text-text dark:text-text-dark mb-4">
                            {t('conversation')}
                        </h2>
                        {initialChatError && (
                            <p className="text-xs text-danger mb-3" role="alert">
                                {initialChatError}
                            </p>
                        )}
                        {messages.length === 0 ? (
                            <p className="text-xs text-text-muted">{t('noMessages')}</p>
                        ) : (
                            <ul className="space-y-4">
                                {messages.map((m) => (
                                    <li key={m.id} className="flex gap-3">
                                        <div
                                            className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm bg-surface-secondary dark:bg-surface-secondary-dark"
                                            aria-hidden
                                        >
                                            {m.authorType === 'agent' ? '🤖' : '👤'}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center justify-between gap-2 text-[11px] text-text-muted">
                                                <span className="font-mono">
                                                    {m.authorId.slice(0, 8)}…
                                                </span>
                                                <span>
                                                    {new Date(m.createdAt).toLocaleString()}
                                                    {m.editedAt && ` · ${t('edited')}`}
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
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        )}

                        <form
                            onSubmit={handlePost}
                            className="mt-5 pt-4 border-t border-border/40 dark:border-border-dark/40 space-y-2"
                        >
                            <textarea
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                rows={3}
                                placeholder={t('draftPlaceholder')}
                                className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3 text-sm text-text dark:text-text-dark"
                            />
                            {postError && (
                                <p className="text-xs text-danger" role="alert">
                                    {postError}
                                </p>
                            )}
                            <div className="flex justify-end">
                                <Button
                                    type="submit"
                                    size="sm"
                                    disabled={pendingPost || !draft.trim()}
                                >
                                    {pendingPost ? '…' : t('post')}
                                </Button>
                            </div>
                        </form>
                    </section>
                </div>

                {/* ---- Right rail: Details + recurring -------------------- */}
                <aside className="space-y-6 lg:sticky lg:top-6 lg:self-start">
                    <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-muted mb-4">
                            Details
                        </h2>
                        <dl className="space-y-4">
                            <DetailRow label="Status">
                                <span
                                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wide ${STATUS_TONES[currentStatus]}`}
                                >
                                    {tStatus(currentStatus)}
                                </span>
                            </DetailRow>
                            <DetailRow label="Priority">
                                <span
                                    className={`inline-flex items-center gap-1.5 text-xs font-medium ${priority.tone}`}
                                >
                                    <span className={`w-2 h-2 rounded-full ${priority.dot}`} />
                                    {priority.label}
                                </span>
                            </DetailRow>
                            <DetailRow label={t('labels')}>
                                {labels.length > 0 ? (
                                    <div className="flex flex-wrap gap-1.5">
                                        {labels.map((l) => (
                                            <span
                                                key={l}
                                                className="text-[10px] px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary"
                                            >
                                                {l}
                                            </span>
                                        ))}
                                    </div>
                                ) : (
                                    <span className="text-xs text-text-muted">—</span>
                                )}
                            </DetailRow>
                            {scope && (
                                <DetailRow label="Scope">
                                    <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
                                        {scope.label}
                                        <span className="font-mono text-text-muted">
                                            {scope.id.slice(0, 8)}…
                                        </span>
                                    </span>
                                </DetailRow>
                            )}
                            <DetailRow label="Created">
                                <span className="text-xs text-text-secondary">
                                    {formatDate(task.createdAt)}
                                </span>
                            </DetailRow>
                            <DetailRow label="Updated">
                                <span className="text-xs text-text-secondary">
                                    {formatDate(task.updatedAt)}
                                </span>
                            </DetailRow>
                        </dl>
                    </div>

                    {/* Phase 17.8 UI — Recurring template controls. */}
                    <TaskRecurringSection task={task} />
                </aside>
            </div>
        </div>
    );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="grid grid-cols-[5.5rem_1fr] items-start gap-3">
            <dt className="text-xs text-text-muted pt-0.5">{label}</dt>
            <dd className="min-w-0">{children}</dd>
        </div>
    );
}
