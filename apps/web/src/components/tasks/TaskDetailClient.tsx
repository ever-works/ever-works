'use client';

import { useRef, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowUpRight, Loader2, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
// Priority dot/tone — shared so the detail rail and the New Task form
// picker cannot drift apart. Labels stay in the `tasksPage.priority`
// i18n namespace.
import { TASK_PRIORITY_PRESENTATION } from '@/lib/task-priorities/catalog';
import type {
    Task,
    TaskActivityRow,
    TaskAttachmentRow,
    TaskChatMessage,
    TaskStatus,
    TaskSubtaskRow,
    TaskSubtasksMeta,
} from '@/lib/api/tasks';
import type { AgentRunSession } from '@/lib/api/agents.shared';
import { postTaskChatAction, transitionTaskAction, updateTaskAction } from '@/app/actions/tasks';
import { TaskScheduleSection } from './TaskScheduleSection';
import { TaskSubtasksSection } from './TaskSubtasksSection';
import { TaskActivitySection } from './TaskActivitySection';
import { TaskAttachmentsSection } from './TaskAttachmentsSection';
import { TaskBranchSection } from './TaskBranchSection';
import { TaskChecksSection } from './TaskChecksSection';
import { TaskRunControls } from './TaskRunControls';
import { TaskRunsHistory } from './TaskRunsHistory';
import { RunWithAgentMenu } from './RunWithAgentMenu';
import { TaskDecisionConflicts } from './TaskDecisionConflicts';
import { TaskDeleteButton } from './TaskDeleteButton';
import { WorkSelect } from './WorkSelect';
import { AgentSelect } from './AgentSelect';
import { TaskExtraReposPicker } from './TaskExtraReposPicker';
import type { TaskExtraRepo } from '@ever-works/contracts';
import { MissionSelect } from './MissionSelect';
import { IdeaSelect } from './IdeaSelect';
// Skills feature — invocation slugs. Task chat is the surface whose
// messages run through `AgentRunService` with kind='chat', which is
// where a leading `/<invocation-slug>` is resolved server-side; the
// popup is the discovery affordance for it.
import { SlashCommandPopup, useSlashCommands } from '@/components/skills/SlashCommandAutocomplete';

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
    initialGateRun = null,
    initialRuns = [],
    initialSubtasks = [],
    initialSubtasksMeta = { total: 0, doneCount: 0 },
    initialSubtasksError = null,
    initialActivity = [],
    initialActivityTotal = 0,
    initialActivityError = null,
}: {
    task: Task;
    initialChat: TaskChatMessage[];
    initialAttachments?: TaskAttachmentRow[];
    initialChatError?: string | null;
    initialAttachmentsError?: string | null;
    /** Tasks upgrades — Subtasks checklist rows + its n/m counters. */
    initialSubtasks?: TaskSubtaskRow[];
    initialSubtasksMeta?: TaskSubtasksMeta;
    initialSubtasksError?: string | null;
    /** Tasks upgrades — per-Task activity feed (audit trail, not chat). */
    initialActivity?: TaskActivityRow[];
    initialActivityTotal?: number;
    initialActivityError?: string | null;
    /**
     * Latest run for this Task, server-fetched (`listSessions({ taskId,
     * limit: 1 })`). Feeds BOTH the quality-gate Checks section (Wave 3 M6 —
     * where the prop got its name) and the run controls (Wave 4 M5/M8): they
     * read different columns of the same row, so re-fetching it twice would
     * be pure waste.
     */
    initialGateRun?: AgentRunSession | null;
    /**
     * Run-driven lifecycle (kanban M7) — the Task's run HISTORY, newest
     * first, server-fetched from the same `listSessions({ taskId })`
     * projection `initialGateRun` comes from (one call, `limit: 10`).
     * A Task accretes many runs; showing only the latest made "did this
     * ever work?" unanswerable from the Task page.
     */
    initialRuns?: AgentRunSession[];
}) {
    const t = useTranslations('dashboard.tasksPage.detail');
    const tStatus = useTranslations('dashboard.tasksPage.status');
    const tPriority = useTranslations('dashboard.tasksPage.priority');
    const [messages, setMessages] = useState(initialChat);
    const [currentStatus, setCurrentStatus] = useState<TaskStatus>(task.status);
    const [draft, setDraft] = useState('');
    const draftRef = useRef<HTMLTextAreaElement | null>(null);
    const [pendingPost, startPost] = useTransition();
    const [pendingTransition, startTransition] = useTransition();
    const [postError, setPostError] = useState<string | null>(null);
    const [transitionError, setTransitionError] = useState<string | null>(null);
    const [description, setDescription] = useState(task.description ?? '');
    const [editingDesc, setEditingDesc] = useState(false);
    const [descDraft, setDescDraft] = useState(task.description ?? '');
    const [pendingDesc, startDesc] = useTransition();
    const [descError, setDescError] = useState<string | null>(null);
    const [workId, setWorkId] = useState<string | null>(task.workId);
    const [pendingWork, startWork] = useTransition();
    const [workError, setWorkError] = useState<string | null>(null);
    // `?? null` on purpose: the API omits owner columns it never set, so
    // an unassigned Task arrives with `agentId` absent, not null.
    const [agentId, setAgentId] = useState<string | null>(task.agentId ?? null);
    const [pendingAgent, startAgent] = useTransition();
    const [agentError, setAgentError] = useState<string | null>(null);
    // Same `?? null` reason as `agentId`: the API omits owner columns it
    // never set, so an unscoped Task arrives with these absent, not null.
    const [missionId, setMissionId] = useState<string | null>(task.missionId ?? null);
    const [pendingMission, startMission] = useTransition();
    const [missionError, setMissionError] = useState<string | null>(null);
    const [ideaId, setIdeaId] = useState<string | null>(task.ideaId ?? null);
    const [pendingIdea, startIdea] = useTransition();
    const [ideaError, setIdeaError] = useState<string | null>(null);
    const router = useRouter();
    // Re-litigation guard (memory upgrades M6). Bumped after a
    // description save so the conflict check re-runs against the new
    // intent — "created OR its description is edited".
    const [conflictKey, setConflictKey] = useState(0);

    // Skills feature — `/slug` completions for the chat draft.
    const slash = useSlashCommands({
        value: draft,
        onChange: setDraft,
        disabled: pendingPost,
        inputRef: draftRef,
    });

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
                    setConflictKey((prev) => prev + 1);
                } catch (err) {
                    setDescError(err instanceof Error ? err.message : t('saveDescriptionError'));
                }
            })();
        });
    };
    // Multi-repo: repositories the Task spans besides its Work's (slice C, PR C2).
    const [extraRepos, setExtraRepos] = useState<TaskExtraRepo[]>(task.extraRepos ?? []);
    const [extraReposError, setExtraReposError] = useState<string | null>(null);
    const [pendingExtraRepos, startExtraRepos] = useTransition();
    const handleExtraReposChange = (next: TaskExtraRepo[]) => {
        const previous = extraRepos;
        setExtraRepos(next);
        setExtraReposError(null);
        startExtraRepos(() => {
            void (async () => {
                try {
                    const updated = await updateTaskAction(task.id, {
                        extraRepos: next.length > 0 ? next : null,
                    });
                    setExtraRepos(updated.extraRepos ?? []);
                    router.refresh();
                } catch (err) {
                    setExtraRepos(previous);
                    setExtraReposError(
                        err instanceof Error ? err.message : t('extraReposUpdateError'),
                    );
                }
            })();
        });
    };
    const handleWorkChange = (next: string) => {
        const nextWorkId = next || null;
        if (nextWorkId === workId) return;
        setWorkError(null);
        startWork(() => {
            void (async () => {
                try {
                    const updated = await updateTaskAction(task.id, { workId: nextWorkId });
                    setWorkId(updated.workId);
                    router.refresh();
                } catch (err) {
                    setWorkError(err instanceof Error ? err.message : t('workUpdateError'));
                }
            })();
        });
    };

    // Assigning the Agent is what lets "Run" dispatch without stopping to
    // ask: the server resolves assignees → this Agent → the Work default.
    // Refreshing afterwards re-reads the Task's run surfaces (candidates,
    // history) against the new assignment.
    const handleAgentChange = (next: string) => {
        const nextAgentId = next || null;
        if (nextAgentId === agentId) return;
        setAgentError(null);
        startAgent(() => {
            void (async () => {
                try {
                    const updated = await updateTaskAction(task.id, { agentId: nextAgentId });
                    setAgentId(updated.agentId ?? null);
                    router.refresh();
                } catch (err) {
                    setAgentError(err instanceof Error ? err.message : t('agentUpdateError'));
                }
            })();
        });
    };

    // Mission and Idea are re-filed exactly like Work: one owner column
    // each, `null` to detach. Ownership is NON-exclusive on the API side
    // (`TASK_OWNER_KEYS`), so setting one never clears the others — which
    // is why these are three independent rows and not one "scope" picker.
    const handleMissionChange = (next: string) => {
        const nextMissionId = next || null;
        if (nextMissionId === missionId) return;
        setMissionError(null);
        startMission(() => {
            void (async () => {
                try {
                    const updated = await updateTaskAction(task.id, { missionId: nextMissionId });
                    setMissionId(updated.missionId ?? null);
                    router.refresh();
                } catch (err) {
                    setMissionError(err instanceof Error ? err.message : t('missionUpdateError'));
                }
            })();
        });
    };

    const handleIdeaChange = (next: string) => {
        const nextIdeaId = next || null;
        if (nextIdeaId === ideaId) return;
        setIdeaError(null);
        startIdea(() => {
            void (async () => {
                try {
                    const updated = await updateTaskAction(task.id, { ideaId: nextIdeaId });
                    setIdeaId(updated.ideaId ?? null);
                    router.refresh();
                } catch (err) {
                    setIdeaError(err instanceof Error ? err.message : t('ideaUpdateError'));
                }
            })();
        });
    };

    // Statuses reachable from the current one — drives which workflow
    // buttons are clickable vs. shown disabled.
    const allowedNext = new Set(NEXT_STATUS[currentStatus] ?? []);
    const labels = task.labels ?? [];
    const priority = TASK_PRIORITY_PRESENTATION[task.priority];

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
                        <div className="flex items-start justify-between gap-3">
                            <h1 className="text-2xl font-semibold leading-tight text-text dark:text-text-dark">
                                {task.title}
                            </h1>
                            <div className="flex items-center gap-1.5 shrink-0">
                                {/* Keyed on the assignment: the picker
                                    caches its candidate list on first open,
                                    so re-assigning must remount it rather
                                    than leave a stale list behind. */}
                                <RunWithAgentMenu key={agentId ?? 'no-agent'} taskId={task.id} />
                                <TaskDeleteButton taskId={task.id} taskSlug={task.slug} />
                            </div>
                        </div>
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
                                        aria-current={isCurrent || undefined}
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

                    {/* Re-litigation guard (memory upgrades M6) — settled
                        decisions this Task appears to re-open. Renders
                        nothing when there are none; never blocks. */}
                    <TaskDecisionConflicts taskId={task.id} refreshKey={conflictKey} />

                    {/* Description — inline editable, saves via updateTaskAction. */}
                    <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                        <div className="flex items-center justify-between mb-3">
                            <h2 className="text-sm font-medium text-text dark:text-text-dark">
                                {t('description')}
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
                                    {t('edit')}
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
                                    placeholder={t('descriptionPlaceholder')}
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
                                        {t('cancel')}
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        disabled={pendingDesc}
                                        onClick={handleSaveDescription}
                                    >
                                        {pendingDesc ? '…' : t('save')}
                                    </Button>
                                </div>
                            </div>
                        ) : description ? (
                            <p className="text-sm leading-relaxed text-text-secondary dark:text-text-secondary-dark whitespace-pre-wrap">
                                {description}
                            </p>
                        ) : (
                            <p className="text-sm text-text-muted italic">{t('noDescription')}</p>
                        )}
                    </section>

                    {/* Tasks upgrades — Subtasks checklist (n/m, per-row
                        agent chip + approval badge, add-subtask input). */}
                    <TaskSubtasksSection
                        task={task}
                        initial={initialSubtasks}
                        initialMeta={initialSubtasksMeta}
                        initialError={initialSubtasksError}
                    />

                    {/* Run steering (Wave 4 M5) + attach action (M8) — steer /
                        interrupt / resume the Task's latest run. Renders
                        nothing when there is no actionable run. */}
                    <TaskRunControls run={initialGateRun} />

                    {/* Quality gates (Wave 3 M6) — Checks section */}
                    <TaskChecksSection task={task} initialGateRun={initialGateRun} />

                    {/* Run-driven lifecycle (kanban M7) — every run this
                        Task has accrued, not just the latest. */}
                    <TaskRunsHistory runs={initialRuns} />

                    {/* FU-5 — Attachments */}
                    <TaskAttachmentsSection
                        key={workId ?? 'no-work'}
                        taskId={task.id}
                        workId={workId}
                        initial={initialAttachments}
                        initialError={initialAttachmentsError}
                    />

                    {/* Tasks upgrades — audit trail for this Task (distinct
                        from the conversation thread below). */}
                    <TaskActivitySection
                        rows={initialActivity}
                        total={initialActivityTotal}
                        error={initialActivityError}
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
                            className="relative mt-5 pt-4 border-t border-border/40 dark:border-border-dark/40 space-y-2"
                        >
                            <SlashCommandPopup state={slash} />
                            <textarea
                                ref={draftRef}
                                value={draft}
                                onChange={(e) => setDraft(e.target.value)}
                                onKeyDown={(e) => slash.handleKeyDown(e)}
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
                            {t('details')}
                        </h2>
                        <dl className="space-y-4">
                            <DetailRow label={t('status')}>
                                <span
                                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wide ${STATUS_TONES[currentStatus]}`}
                                >
                                    {tStatus(currentStatus)}
                                </span>
                            </DetailRow>
                            <DetailRow label={t('priority')}>
                                <span
                                    className={`inline-flex items-center gap-1.5 text-xs font-medium ${priority.tone}`}
                                >
                                    <span className={`w-2 h-2 rounded-full ${priority.dot}`} />
                                    {tPriority(task.priority)}
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
                            {/* Work / Mission / Idea are the three SCOPE owners and
                                sit together; Agent (who works it) follows. All
                                four are independent columns — picking one never
                                clears another. */}
                            <AssignmentRow
                                label={t('scopeWork')}
                                href={workId ? ROUTES.DASHBOARD_WORK(workId) : null}
                                openLabel={t('openWork')}
                                error={workError}
                                testId="task-detail-work-open"
                            >
                                <WorkSelect
                                    value={workId ?? ''}
                                    onValueChange={handleWorkChange}
                                    disabled={pendingWork}
                                    size="xs"
                                    noneLabel={t('workNone')}
                                    placeholder={t('workPlaceholder')}
                                    testId="task-detail-work"
                                />
                            </AssignmentRow>
                            <AssignmentRow
                                label={t('scopeMission')}
                                href={missionId ? ROUTES.DASHBOARD_MISSION(missionId) : null}
                                openLabel={t('openMission')}
                                error={missionError}
                                testId="task-detail-mission-open"
                            >
                                <MissionSelect
                                    value={missionId ?? ''}
                                    onValueChange={handleMissionChange}
                                    disabled={pendingMission}
                                    size="xs"
                                    noneLabel={t('missionNone')}
                                    placeholder={t('missionPlaceholder')}
                                    testId="task-detail-mission"
                                />
                            </AssignmentRow>
                            <AssignmentRow
                                label={t('scopeIdea')}
                                href={ideaId ? ROUTES.DASHBOARD_IDEA(ideaId) : null}
                                openLabel={t('openIdea')}
                                error={ideaError}
                                testId="task-detail-idea-open"
                            >
                                <IdeaSelect
                                    value={ideaId ?? ''}
                                    onValueChange={handleIdeaChange}
                                    disabled={pendingIdea}
                                    size="xs"
                                    noneLabel={t('ideaNone')}
                                    placeholder={t('ideaPlaceholder')}
                                    testId="task-detail-idea"
                                />
                            </AssignmentRow>
                            <AssignmentRow
                                label={t('agent')}
                                href={agentId ? ROUTES.DASHBOARD_AGENT(agentId) : null}
                                openLabel={t('openAgent')}
                                error={agentError}
                                testId="task-detail-agent-open"
                            >
                                <AgentSelect
                                    value={agentId ?? ''}
                                    onValueChange={handleAgentChange}
                                    disabled={pendingAgent}
                                    size="xs"
                                    noneLabel={t('agentNone')}
                                    placeholder={t('agentPlaceholder')}
                                    testId="task-detail-agent"
                                />
                            </AssignmentRow>
                            <DetailRow label={t('extraRepos')}>
                                <div className="space-y-1">
                                    <TaskExtraReposPicker
                                        value={extraRepos}
                                        onChange={handleExtraReposChange}
                                        disabled={pendingExtraRepos}
                                        testId="task-detail-extra-repos"
                                    />
                                    {extraReposError && (
                                        <p
                                            className="text-xs text-danger"
                                            data-testid="task-detail-extra-repos-error"
                                        >
                                            {extraReposError}
                                        </p>
                                    )}
                                </div>
                            </DetailRow>
                            <DetailRow label={t('created')}>
                                <span className="text-xs text-text-secondary">
                                    {formatDate(task.createdAt)}
                                </span>
                            </DetailRow>
                            <DetailRow label={t('updated')}>
                                <span className="text-xs text-text-secondary">
                                    {formatDate(task.updatedAt)}
                                </span>
                            </DetailRow>
                        </dl>
                    </div>

                    {/* Wave 2 M7 — isolated-branch cockpit / isolation override. */}
                    <TaskBranchSection task={task} />

                    {/* Tasks upgrades — Schedule section: Run once |
                        Scheduled (one-shot) | Recurring (Phase 17.8 panel,
                        rendered by the section for the recurring mode). */}
                    <TaskScheduleSection task={task} />
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

/**
 * A Details row whose value is an ASSIGNMENT — Work, Mission, Idea or
 * Agent. The picker changes what the Task is filed under; the arrow next
 * to it goes and looks at the thing itself, which the picker alone can
 * never do (it shows a name, not what that name refers to).
 *
 * The arrow appears only when something IS assigned: there is nothing to
 * open otherwise, and a permanently-visible dead control in a four-row
 * stack reads as broken rather than empty.
 *
 * `error` is the row's UPDATE failure. Each picker renders its own LOAD
 * failure internally — the two are different problems (this assignment
 * would not save vs. the list could not be fetched) and are reported
 * separately on purpose.
 */
export function AssignmentRow({
    label,
    href,
    openLabel,
    error,
    testId,
    children,
}: {
    label: string;
    href: string | null;
    openLabel: string;
    error: string | null;
    testId?: string;
    children: React.ReactNode;
}) {
    return (
        <DetailRow label={label}>
            <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                    {/* min-w-0 so a long name truncates inside the picker
                        instead of pushing the arrow out of the rail. */}
                    <div className="min-w-0 flex-1">{children}</div>
                    {href && (
                        <Link
                            href={href}
                            aria-label={openLabel}
                            title={openLabel}
                            data-testid={testId}
                            className="grid size-6 shrink-0 place-items-center rounded text-text-muted hover:text-text dark:hover:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors"
                        >
                            {/* `dir="rtl"` is set on <html> for ar/he
                                (RTL_LOCALES), where an arrow pointing
                                right points back INTO the text. Mirror
                                it so "away" stays away. */}
                            <ArrowUpRight className="size-3.5 rtl:-scale-x-100" aria-hidden />
                        </Link>
                    )}
                </div>
                {error && (
                    <p className="text-[11px] text-danger" role="alert">
                        {error}
                    </p>
                )}
            </div>
        </DetailRow>
    );
}
