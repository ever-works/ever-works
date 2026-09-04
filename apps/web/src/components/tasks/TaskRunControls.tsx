'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
    Loader2,
    MessageSquareReply,
    OctagonPause,
    PlayCircle,
    SendHorizontal,
    SquareTerminal,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import type { AgentRunSession } from '@/lib/api/agents.shared';
import {
    interruptAgentRunAction,
    resumeAgentRunAction,
    steerAgentRunAction,
} from '@/app/actions/agents';

/**
 * Run steering (Wave 4 M5) + attach-session action (Wave 4 M8) — the run
 * cockpit on Task detail.
 *
 * Four verbs on the Task's latest run, exactly the ones the orchestration
 * model defines:
 *
 *  - **Steer**     — send a message into the LIVE session. The server injects
 *                    it between the agent's tool-loop iterations; if the run
 *                    finished while the user was typing, the server answers
 *                    `new-run` and we say so instead of silently dropping it.
 *  - **Interrupt** — cooperative stop, behind a confirm. The run halts between
 *                    iterations and completes with a summary — it does NOT
 *                    kill the process mid-flight (that is Cancel, which lives
 *                    on the Sessions/Activity surfaces).
 *  - **Resume**    — for a parked / awaiting-input run: start a NEW run
 *                    carrying the same pipeline session, optionally with a
 *                    first message.
 *  - **Attach**    — deep link into the run's terminal pane, shown only when
 *                    the server says the session is actually joinable
 *                    (`sessionAttachable`).
 *
 * One state REPLACES the resume form (self-build slice Q): a run a FLEET
 * node parked on an owner question (`openQuestion` set, run awaiting
 * input, not live). The Inbox reply is the only path that carries the
 * answer — it starts the new run with the question and answer in its
 * instructions — so this strip shows the question and links to the Inbox
 * instead of offering a free-text Resume that would start a run which
 * never sees the answer and leaves the Inbox item open.
 *
 * Renders nothing when the Task has no run yet: an empty control strip on a
 * Task that never dispatched is noise.
 */
export interface TaskRunOpenQuestion {
    /** Inbox item id — the `/inbox?id=` deep link. */
    id: string;
    /** The question line (the Inbox title), shown verbatim as text. */
    title: string;
}

export function TaskRunControls({
    run,
    openQuestion = null,
}: {
    run: AgentRunSession | null;
    /**
     * The OPEN Inbox question this Task's parked run is waiting on, when
     * the page found one (`GET /api/inbox?taskId=&status=open`). Null =
     * no question known — the classic resume form renders as before.
     */
    openQuestion?: TaskRunOpenQuestion | null;
}) {
    const t = useTranslations('dashboard.tasksPage.detail.runControls');
    const [draft, setDraft] = useState('');
    const [notice, setNotice] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, startAction] = useTransition();

    if (!run) return null;

    const isLive = run.status === 'queued' || run.status === 'running';
    const isResumable = run.awaitingInput === true || run.terminalEndedReason === 'parked';
    // Nothing actionable on a plain finished run — don't render a dead strip.
    if (!isLive && !isResumable && !run.sessionAttachable) return null;

    // Slice Q — parked on an owner question. Only a NON-live awaiting run
    // qualifies: a live run with a stale question in the list (the resumed
    // run is already going) keeps its steer controls.
    const waitingOnQuestion = !isLive && run.awaitingInput === true && openQuestion !== null;

    const act = (fn: () => Promise<string | null>) => {
        setError(null);
        setNotice(null);
        startAction(() => {
            void (async () => {
                try {
                    setNotice(await fn());
                } catch (err) {
                    setError(err instanceof Error ? err.message : t('genericError'));
                }
            })();
        });
    };

    const handleSteer = (e: React.FormEvent) => {
        e.preventDefault();
        const message = draft.trim();
        if (!message) return;
        act(async () => {
            const result = await steerAgentRunAction(run.agentId, run.id, message);
            setDraft('');
            // `new-run` is a normal race, not a failure — but the user MUST be
            // told, because their message did not reach the agent.
            return result.dispatched === 'injected' ? t('steerInjected') : t('steerNeedsNewRun');
        });
    };

    const handleInterrupt = () => {
        if (!window.confirm(t('confirmInterrupt'))) return;
        act(async () => {
            await interruptAgentRunAction(run.agentId, run.id);
            return t('interruptRequested');
        });
    };

    const handleResume = () => {
        const message = draft.trim();
        act(async () => {
            const result = await resumeAgentRunAction(run.agentId, run.id, message || null);
            setDraft('');
            return result.queued ? t('resumeQueued') : t('resumeDispatched');
        });
    };

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5"
            data-testid="task-run-controls"
            data-run-status={run.status}
        >
            <div className="flex items-center justify-between gap-3 mb-3">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">{t('title')}</h2>
                <div className="flex items-center gap-2">
                    {run.awaitingInput && (
                        <span
                            className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300"
                            data-testid="task-run-awaiting-badge"
                        >
                            {t('awaitingInput')}
                        </span>
                    )}
                    {/* Attach-session action (Wave 4 M8) — terminal icon → the
                        run's session pane. Gated on the server's own
                        joinability verdict. */}
                    {run.sessionAttachable && (
                        <Link
                            href={`${ROUTES.DASHBOARD_AGENT_TERMINAL(run.agentId)}?run=${run.id}`}
                            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                            data-testid="task-run-attach"
                            title={t('attachHint')}
                        >
                            <SquareTerminal className="w-3.5 h-3.5" />
                            {t('attach')}
                        </Link>
                    )}
                </div>
            </div>

            {waitingOnQuestion ? (
                // Same amber treatment as the Inbox "waiting for your reply"
                // banner: it is the same wait, seen from the Task side.
                <div
                    className="rounded-lg border border-amber-200 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
                    data-testid="task-run-open-question"
                >
                    <p className="font-medium">{t('waitingForAnswer')}</p>
                    <p
                        className="mt-1 whitespace-pre-wrap"
                        data-testid="task-run-open-question-title"
                    >
                        {openQuestion.title}
                    </p>
                    <Link
                        href={`${ROUTES.DASHBOARD_INBOX}?id=${encodeURIComponent(openQuestion.id)}`}
                        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                        data-testid="task-run-open-question-link"
                    >
                        <MessageSquareReply className="w-3.5 h-3.5" />
                        {t('answerInInbox')}
                    </Link>
                    <p className="mt-2 text-xs text-amber-800/80 dark:text-amber-200/80">
                        {t('parkedHintQuestion')}
                    </p>
                </div>
            ) : (
                <>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mb-3">
                        {isLive ? t('liveHint') : t('parkedHint')}
                    </p>

                    <form onSubmit={handleSteer} className="space-y-2">
                        <textarea
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            rows={2}
                            maxLength={16384}
                            placeholder={isLive ? t('steerPlaceholder') : t('resumePlaceholder')}
                            className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-3 text-sm text-text dark:text-text-dark"
                            data-testid="task-run-steer-input"
                        />
                        {error && (
                            <p
                                className="text-xs text-danger"
                                role="alert"
                                data-testid="task-run-error"
                            >
                                {error}
                            </p>
                        )}
                        {notice && (
                            <p
                                className="text-xs text-text-secondary dark:text-text-secondary-dark"
                                role="status"
                                data-testid="task-run-notice"
                            >
                                {notice}
                            </p>
                        )}
                        <div className="flex flex-wrap items-center justify-end gap-2">
                            {pending && (
                                <Loader2 className="w-4 h-4 animate-spin text-text-muted" />
                            )}
                            {isLive && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs gap-1.5"
                                    disabled={pending}
                                    onClick={handleInterrupt}
                                    data-testid="task-run-interrupt"
                                >
                                    <OctagonPause className="w-3.5 h-3.5" />
                                    {t('interrupt')}
                                </Button>
                            )}
                            {isResumable && (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    className="text-xs gap-1.5"
                                    disabled={pending}
                                    onClick={handleResume}
                                    data-testid="task-run-resume"
                                >
                                    <PlayCircle className="w-3.5 h-3.5" />
                                    {t('resume')}
                                </Button>
                            )}
                            {isLive && (
                                <Button
                                    type="submit"
                                    size="sm"
                                    className="text-xs gap-1.5"
                                    disabled={pending || !draft.trim()}
                                    data-testid="task-run-steer-submit"
                                >
                                    <SendHorizontal className="w-3.5 h-3.5" />
                                    {t('steer')}
                                </Button>
                            )}
                        </div>
                    </form>
                </>
            )}
        </section>
    );
}
