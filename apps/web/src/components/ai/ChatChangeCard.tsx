'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Circle, GitPullRequestArrow, Loader2, X } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { getTaskChangeChainAction, type TaskChangeChain } from '@/app/actions/tasks';
import { getAppChangeTargetAction } from '@/app/actions/dashboard/app-changes';
import { useChatContext } from './ChatProvider';
import { cancelCardMessage, confirmCardMessage } from './confirm-card-messages';

/** FR-44 — the chain card refreshes every 10 seconds while visible … */
export const CHANGE_CARD_POLL_INTERVAL_MS = 10_000;
/** … and stops after 30 minutes without a change. */
export const CHANGE_CARD_IDLE_MAX_MS = 30 * 60_000;

export const APP_CHANGE_TOOL = 'request_app_change';

export type ChangeStep = 'run' | 'pullRequest' | 'build' | 'deployment' | 'live';
export type ChangeStepState = 'done' | 'active' | 'failed' | 'pending';

const STEPS: readonly ChangeStep[] = ['run', 'pullRequest', 'build', 'deployment', 'live'];
const STEP_LABEL: Record<ChangeStep, string> = {
    run: 'stepRun',
    pullRequest: 'stepPullRequest',
    build: 'stepBuild',
    deployment: 'stepDeployment',
    live: 'stepLive',
};
const STATE_LABEL: Record<ChangeStepState, string> = {
    done: 'stateDone',
    active: 'stateActive',
    failed: 'stateFailed',
    pending: 'statePending',
};
/** Delivery states after the merge: the run and the pull request are behind them. */
const DELIVERED_PAST_MERGE: ReadonlySet<string> = new Set([
    'merged',
    'building',
    'built',
    'build_failed',
    'deploying',
    'deploy_failed',
    'live',
    'closed_without_deploy',
]);
const PAST_BUILD: ReadonlySet<string> = new Set(['built', 'deploying', 'deploy_failed', 'live']);

/**
 * Spec §6.4 — where a filed App change stands, step by step: Run → Pull request → Build →
 * Deployment → Live. Every step's state is also TEXT (`stateDone` …) — never colour alone (§6.6).
 */
export function changeChainSteps(chain: TaskChangeChain): Record<ChangeStep, ChangeStepState> {
    const delivery = chain.deliveryState ?? null;
    const merged = Boolean(delivery && DELIVERED_PAST_MERGE.has(delivery)) || chain.prState === 'merged';

    let run: ChangeStepState = 'pending';
    if (merged || chain.prNumber) run = 'done';
    else if (chain.runStatus === 'queued' || chain.runStatus === 'running') run = 'active';
    else if (chain.runStatus === 'completed') run = 'done';
    else if (chain.runStatus === 'failed' || chain.runStatus === 'cancelled') run = 'failed';

    let pullRequest: ChangeStepState = 'pending';
    if (merged || chain.prState === 'open' || chain.prState === 'draft') pullRequest = 'done';
    else if (chain.prState === 'closed') pullRequest = 'failed';
    else if (chain.prNumber) pullRequest = 'done';

    let build: ChangeStepState = 'pending';
    if (delivery === 'building') build = 'active';
    else if (delivery === 'build_failed') build = 'failed';
    else if (delivery && PAST_BUILD.has(delivery)) build = 'done';

    let deployment: ChangeStepState = 'pending';
    if (delivery === 'deploying') deployment = 'active';
    else if (delivery === 'deploy_failed') deployment = 'failed';
    else if (delivery === 'live') deployment = 'done';

    const live: ChangeStepState = delivery === 'live' ? 'done' : 'pending';
    return { run, pullRequest, build, deployment, live };
}

/** Nothing more will happen to this chain on its own: stop polling. */
export function isChangeChainSettled(chain: TaskChangeChain): boolean {
    const delivery = chain.deliveryState ?? null;
    if (delivery === 'live' || delivery === 'closed_without_deploy') return true;
    if (chain.status === 'cancelled') return true;
    // Done without a delivery chain = the change completed on merge (not tracked); done WITH an
    // open chain is still being followed.
    return chain.status === 'done' && (!delivery || delivery === 'build_failed' || delivery === 'deploy_failed');
}

interface ConfirmationShape {
    __confirmationRequired: true;
    target?: string;
    args?: { id?: unknown; body?: { request?: unknown; agentId?: unknown } };
}

interface AnswerShape {
    success: true;
    data: {
        taskId: string;
        taskSlug?: string;
        awaitingOwner?: boolean;
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isAppChangeConfirmation(output: unknown): output is ConfirmationShape {
    return isRecord(output) && output.__confirmationRequired === true;
}

export function isAppChangeAnswer(output: unknown): output is AnswerShape {
    return (
        isRecord(output) &&
        output.success === true &&
        isRecord(output.data) &&
        typeof output.data.taskId === 'string' &&
        output.data.taskId.length > 0
    );
}

/** Whether the card renders this `request_app_change` output (else the generic result does). */
export function isAppChangeCardOutput(output: unknown): boolean {
    return isAppChangeConfirmation(output) || isAppChangeAnswer(output);
}

function text(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * APW-08 T26 (`ChatChangeCard`, spec §6.4, FR-44) — the chat's inline card for `request_app_change`.
 *
 *  - **Confirmation** (the tool's `__confirmationRequired` answer): "Start a change on {work}? ·
 *    {agent} will work on it. An agent run will start; runs are billed to your workspace." with
 *    **Cancel** / **Start**. The buttons send exactly the generic confirmation card's messages, so
 *    the server-side check (`generated/confirmation.ts`) honours this card and no other.
 *  - **Reply + chain** (the filed Task): "Started T-118 on Bookings." and the chain Run → Pull
 *    request → Build → Deployment → Live with **Open the Task**. Refreshes every 10 s while the
 *    page is visible, stops once the chain is settled or after 30 minutes without a change.
 */
export function ChatChangeCard({
    toolCallId,
    output,
    input,
}: {
    toolCallId: string;
    output: unknown;
    /** The tool call's arguments (`{ id, body }`), when the chat has them. */
    input?: unknown;
}) {
    if (isAppChangeConfirmation(output)) {
        return <ChangeConfirmation toolCallId={toolCallId} confirmation={output} />;
    }
    if (isAppChangeAnswer(output)) {
        const workId = isRecord(input) ? text(input.id) : null;
        return <ChangeChain answer={output.data} workId={workId} />;
    }
    return null;
}

function useTargetNames(workId: string | null, agentId: string | null) {
    const [names, setNames] = useState<{ workName: string | null; agentName: string | null }>({
        workName: null,
        agentName: null,
    });
    useEffect(() => {
        if (!workId) return;
        let cancelled = false;
        getAppChangeTargetAction(workId, agentId)
            .then((result) => {
                if (!cancelled) setNames(result);
            })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [workId, agentId]);
    return names;
}

function ChangeConfirmation({
    toolCallId,
    confirmation,
}: {
    toolCallId: string;
    confirmation: ConfirmationShape;
}) {
    const t = useTranslations('dashboard.workDetail.requestChange');
    const tCard = useTranslations('dashboard.aiChat.changeCard');
    const { sendMessage } = useChatContext();
    const [resolved, setResolved] = useState<null | 'started' | 'cancelled'>(null);
    const args = confirmation.args ?? {};
    const workId = text(args.id);
    const request = text(args.body?.request);
    const { workName, agentName } = useTargetNames(workId, text(args.body?.agentId));

    if (resolved) {
        return (
            <span
                className="inline-flex items-center gap-1 mt-1 text-[10px] text-text-muted dark:text-text-muted-dark"
                data-testid="chat-change-card-resolved"
            >
                {resolved === 'started' ? (
                    <Loader2 className="w-2.5 h-2.5 animate-spin" aria-hidden="true" />
                ) : (
                    <X className="w-2.5 h-2.5" aria-hidden="true" />
                )}
                {resolved === 'started' ? tCard('starting') : tCard('cancelled')}
            </span>
        );
    }

    return (
        <div
            className="mt-2 p-3 rounded-lg border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark"
            data-testid="chat-change-card-confirm"
        >
            <div className="flex items-center gap-2 mb-1.5">
                <GitPullRequestArrow
                    className="w-4 h-4 text-text-muted dark:text-text-muted-dark"
                    aria-hidden="true"
                />
                <span className="text-xs font-medium text-text dark:text-text-dark">
                    {workName ? t('title', { work: workName }) : t('titleUnnamed')}
                </span>
            </div>
            <p className="text-[11px] text-text-muted dark:text-text-muted-dark mb-2">
                {agentName ? t('body', { agent: agentName }) : t('bodyNoAgent')}
            </p>
            {request ? (
                // Rendered as text (React escapes it): the person confirms the words that become
                // the Task's brief, not only the action.
                <blockquote
                    className="mb-3 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-surface-secondary p-2 text-[11px] text-text dark:border-white/15 dark:bg-white/5 dark:text-text-dark"
                    data-testid="chat-change-card-request"
                >
                    {request}
                </blockquote>
            ) : null}
            <div className="flex justify-end gap-2">
                <button
                    type="button"
                    onClick={() => {
                        setResolved('cancelled');
                        sendMessage(
                            cancelCardMessage({ toolName: APP_CHANGE_TOOL, target: confirmation.target }),
                        );
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark transition-colors cursor-pointer"
                    data-testid="chat-change-card-cancel"
                >
                    {t('cancel')}
                </button>
                <button
                    type="button"
                    onClick={() => {
                        setResolved('started');
                        sendMessage(
                            confirmCardMessage({
                                toolCallId,
                                toolName: APP_CHANGE_TOOL,
                                target: confirmation.target,
                            }),
                        );
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-gray-900 text-white hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100 transition-colors cursor-pointer"
                    data-testid="chat-change-card-start"
                >
                    <Check className="w-3 h-3" aria-hidden="true" />
                    {t('start')}
                </button>
            </div>
        </div>
    );
}

const STEP_ICON_TONE: Record<ChangeStepState, string> = {
    done: 'text-emerald-600 dark:text-emerald-400',
    active: 'text-sky-600 dark:text-sky-400 animate-spin',
    failed: 'text-red-600 dark:text-red-400',
    pending: 'text-text-muted dark:text-text-muted-dark',
};

function StepIcon({ state }: { state: ChangeStepState }) {
    const className = cn('w-3 h-3 shrink-0', STEP_ICON_TONE[state]);
    if (state === 'done') return <Check className={className} aria-hidden="true" />;
    if (state === 'active') return <Loader2 className={className} aria-hidden="true" />;
    if (state === 'failed') return <X className={className} aria-hidden="true" />;
    return <Circle className={className} aria-hidden="true" />;
}

function ChangeChain({ answer, workId }: { answer: AnswerShape['data']; workId: string | null }) {
    const t = useTranslations('dashboard.aiChat.changeCard');
    const { workName } = useTargetNames(workId, null);
    const [chain, setChain] = useState<TaskChangeChain | null>(null);
    const [reads, setReads] = useState(0);
    const [stopped, setStopped] = useState(false);
    const lastChange = useRef<number>(0);
    const lastSeen = useRef<string>('');
    const cancelled = useRef(false);
    const taskId = answer.taskId;

    const read = useCallback(async () => {
        try {
            const hidden =
                typeof document !== 'undefined' && document.visibilityState === 'hidden';
            if (!hidden) {
                const result = await getTaskChangeChainAction(taskId);
                if (cancelled.current) return;
                if (result.ok) {
                    const seen = JSON.stringify(result.chain);
                    if (seen !== lastSeen.current) {
                        lastSeen.current = seen;
                        lastChange.current = Date.now();
                    }
                    setChain(result.chain);
                }
            }
        } catch {
            // A failed poll keeps the last answer and tries again on the next tick.
        } finally {
            if (!cancelled.current) setReads((n) => n + 1);
        }
    }, [taskId]);

    useEffect(() => {
        cancelled.current = false;
        lastChange.current = Date.now();
        void read();
        return () => {
            cancelled.current = true;
        };
    }, [read]);

    useEffect(() => {
        if (reads === 0 || stopped) return;
        if (chain && isChangeChainSettled(chain)) return;
        if (Date.now() - lastChange.current >= CHANGE_CARD_IDLE_MAX_MS) {
            setStopped(true);
            return;
        }
        const timer = setTimeout(() => void read(), CHANGE_CARD_POLL_INTERVAL_MS);
        return () => clearTimeout(timer);
    }, [reads, chain, stopped, read]);

    const slug = chain?.slug ?? answer.taskSlug ?? '';
    const steps = chain ? changeChainSteps(chain) : null;

    return (
        <div
            className="mt-2 p-3 rounded-lg border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark space-y-2"
            data-testid="chat-change-card-chain"
            data-task-id={taskId}
        >
            <p className="text-xs text-text dark:text-text-dark" role="status">
                {workName ? t('started', { slug, work: workName }) : t('startedUnnamed', { slug })}
            </p>
            {answer.awaitingOwner && (
                <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
                    {t('awaitingOwner')}
                </p>
            )}
            {chain?.title && (
                <p className="text-[11px] font-medium text-text dark:text-text-dark truncate">
                    <span className="font-mono text-text-muted dark:text-text-muted-dark mr-1">
                        {chain.slug}
                    </span>
                    {chain.title}
                </p>
            )}
            <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px]" data-testid="chat-change-card-steps">
                {STEPS.map((step, index) => {
                    const state: ChangeStepState = steps?.[step] ?? 'pending';
                    const label = t(STEP_LABEL[step] as never);
                    return (
                        <li
                            key={step}
                            className="inline-flex items-center gap-1 text-text-secondary dark:text-text-secondary-dark"
                            data-testid={`chat-change-step-${step}`}
                            data-state={state}
                        >
                            {index > 0 && (
                                <span className="text-text-muted dark:text-text-muted-dark" aria-hidden="true">
                                    ─
                                </span>
                            )}
                            <span>{label}</span>
                            <StepIcon state={state} />
                            <span className="sr-only">
                                {t(STATE_LABEL[state] as never, { step: label } as never)}
                            </span>
                        </li>
                    );
                })}
            </ol>
            {stopped && (
                <p
                    className="text-[11px] text-text-muted dark:text-text-muted-dark"
                    data-testid="chat-change-card-polling-stopped"
                >
                    {t('pollingStopped')}
                </p>
            )}
            <div className="flex justify-end">
                <Link
                    href={ROUTES.DASHBOARD_TASK(taskId)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                    data-testid="chat-change-card-open-task"
                >
                    {t('openTask')}
                </Link>
            </div>
        </div>
    );
}
