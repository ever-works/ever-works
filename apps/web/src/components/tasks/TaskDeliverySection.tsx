'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Check, CircleDashed, Loader2, Minus, X } from 'lucide-react';
import {
    TASK_DELIVERY_CLOSABLE_STATES,
    TASK_DELIVERY_OPEN_STATES,
    type TaskDeliveryState,
    type TaskDeliveryView,
} from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { safeHttpsUrl, safeWebUrl } from '@/lib/utils/safe-link';
import {
    closeDeliveryAction,
    createDeliveryFixTaskAction,
    getTaskDeliveryAction,
    openDeliveryFollowUpAction,
} from '@/app/actions/tasks';
import { AppDeployNowButton } from '@/components/works/detail/deploy/app/AppDeployNowButton';
import {
    TaskDeliveryChips,
    useDeliveryChipText,
    type TaskDeliveryChipInput,
} from './TaskDeliveryChips';

/** Plan §5.1 — `GET /delivery` every 10 s while the chain is open … */
export const DELIVERY_POLL_INTERVAL_MS = 10_000;
/** … for at most 30 minutes after the page opened. */
export const DELIVERY_POLL_MAX_MS = 30 * 60_000;

const OPEN_STATES: ReadonlySet<string> = new Set(TASK_DELIVERY_OPEN_STATES);
const CLOSABLE_STATES: ReadonlySet<string> = new Set(TASK_DELIVERY_CLOSABLE_STATES);
const FAILED_STATES: ReadonlySet<string> = new Set(['build_failed', 'deploy_failed']);
/** Task statuses with a `dashboard.tasksPage.status.*` label (a follow-up is a Task). */
const TASK_STATUS_KEYS: ReadonlySet<string> = new Set([
    'backlog',
    'todo',
    'in_progress',
    'in_review',
    'blocked',
    'done',
    'cancelled',
]);

/** A state the chain still has work on (the section keeps polling). */
export function isDeliveryOpen(state: TaskDeliveryState | null | undefined): boolean {
    return Boolean(state && OPEN_STATES.has(state));
}

/** Which `delivery.errors.*` copy a refusal gets — by the API's own code, never a message. */
export function deliveryErrorKey(
    code: string | undefined,
): 'notClosable' | 'followUpLimit' | 'fixTaskUnavailable' | 'generic' {
    return code === 'notClosable' || code === 'followUpLimit' || code === 'fixTaskUnavailable'
        ? code
        : 'generic';
}

/** The section's primary call-to-action look (white in dark mode). */
const PRIMARY_CTA = 'dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100';

type FixTaskResult = { taskId: string; slug: string | null; created: boolean };

type Step = 'done' | 'progress' | 'failed' | 'neutral';

const STEP_ICONS: Record<Step, typeof Check> = {
    done: Check,
    progress: Loader2,
    failed: X,
    neutral: Minus,
};

const STEP_TONES: Record<Step, string> = {
    done: 'text-emerald-600 dark:text-emerald-400',
    progress: 'text-sky-600 dark:text-sky-400 animate-spin',
    failed: 'text-red-600 dark:text-red-400',
    neutral: 'text-text-muted dark:text-text-muted-dark',
};

function buildStep(state: TaskDeliveryState): Step {
    if (state === 'building' || state === 'merged') return 'progress';
    if (state === 'build_failed') return 'failed';
    if (state === 'closed_without_deploy') return 'neutral';
    return 'done';
}

function deploymentStep(state: TaskDeliveryState): Step {
    if (state === 'deploying') return 'progress';
    if (state === 'deploy_failed') return 'failed';
    if (state === 'live') return 'done';
    return 'neutral';
}

/** When the chain last entered one of `states` (the timeline's time for that row). */
function phaseAt(view: TaskDeliveryView, states: readonly TaskDeliveryState[]): string | null {
    const entries = view.history.filter((entry) => states.includes(entry.state));
    return entries.length > 0 ? entries[entries.length - 1].at : null;
}

type Load =
    | { kind: 'loading' }
    | { kind: 'unavailable' }
    | { kind: 'ready'; view: TaskDeliveryView; retryEscalationId: string | null };

/**
 * APW-08 T27 (`TaskDeliverySection`, spec §6.2) — the Task page's **Delivery** section, above
 * Checks, for a Task the delivery chain tracks: the timeline (pull request merged → Build →
 * Deployment → live) with the Build and Deployment links, the live URL, warnings and follow-ups;
 * **Close anyway** (confirmed, focus returned to where it came from) and, when the change's
 * delivery-failed Inbox item is open, **Try once more**.
 *
 * APW-08 T27 (lane L5) adds the section's two remaining actions:
 *
 *  - **Deploy now** (S20) for a `built` change whose App Work deploys somewhere with auto-deploy
 *    off (`view.canDeployNow`): APW-06's own **Deploy now** (`AppDeployNowButton`,
 *    `POST /api/works/:id/deploy`) for THIS change's Build, with every answer it renders;
 *  - **Create a fix Task** for a failed Build or Deployment (when **Try once more** is not the
 *    offer): confirmed first — it can start a paid agent run — then the fix Task filed the way the
 *    automatic follow-up is, one per failure, linked from the section.
 *
 * Polls `GET /delivery` every 10 s while the state is open and stops at a terminal state
 * (`live`, `closed_without_deploy`) or 30 minutes after the page opened, whichever is first.
 */
export function TaskDeliverySection({ taskId, workId }: { taskId: string; workId: string | null }) {
    const t = useTranslations('dashboard.tasksPage.delivery');
    const tStatus = useTranslations('dashboard.tasksPage.status');
    const chipText = useDeliveryChipText();
    const format = useFormatter();
    const [load, setLoad] = useState<Load>({ kind: 'loading' });
    /** Bumped after every read, so a failed poll still schedules the next one. */
    const [reads, setReads] = useState(0);
    const [pollingStopped, setPollingStopped] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [closing, setClosing] = useState(false);
    const [retrying, setRetrying] = useState(false);
    const [errorKey, setErrorKey] = useState<ReturnType<typeof deliveryErrorKey> | null>(null);
    const [followUpOpened, setFollowUpOpened] = useState(false);
    const [fixConfirmOpen, setFixConfirmOpen] = useState(false);
    const [creatingFix, setCreatingFix] = useState(false);
    const [fixResult, setFixResult] = useState<FixTaskResult | null>(null);
    const fixTriggerRef = useRef<HTMLButtonElement | null>(null);
    const fixConfirmWasOpen = useRef(false);
    // Set when the section mounts (the effect below); the 30-minute poll budget counts from it.
    const startedAt = useRef<number>(0);
    const closeTriggerRef = useRef<HTMLButtonElement | null>(null);
    const headingRef = useRef<HTMLHeadingElement | null>(null);
    const confirmWasOpen = useRef(false);
    const cancelled = useRef(false);

    const read = useCallback(async () => {
        try {
            const result = await getTaskDeliveryAction(taskId);
            if (cancelled.current) return;
            if (result.ok) {
                setLoad({
                    kind: 'ready',
                    view: result.view,
                    retryEscalationId: result.retryEscalationId,
                });
            } else {
                // A failed poll keeps the last answer; only a failed FIRST read says so.
                setLoad((previous) =>
                    previous.kind === 'ready' ? previous : { kind: 'unavailable' },
                );
            }
        } catch {
            if (!cancelled.current) {
                setLoad((previous) =>
                    previous.kind === 'ready' ? previous : { kind: 'unavailable' },
                );
            }
        } finally {
            if (!cancelled.current) setReads((n) => n + 1);
        }
    }, [taskId]);

    useEffect(() => {
        cancelled.current = false;
        startedAt.current = Date.now();
        void read();
        return () => {
            cancelled.current = true;
        };
    }, [read]);

    const state = load.kind === 'ready' ? load.view.state : null;

    // The poll: one timer at a time, re-armed after each read while the chain is open.
    useEffect(() => {
        if (reads === 0 || !isDeliveryOpen(state)) return;
        if (Date.now() - startedAt.current >= DELIVERY_POLL_MAX_MS) {
            setPollingStopped(true);
            return;
        }
        const timer = setTimeout(() => void read(), DELIVERY_POLL_INTERVAL_MS);
        return () => clearTimeout(timer);
    }, [reads, state, read]);

    // Focus goes back where it came from when the confirm closes: the Close button, or — once
    // the change is closed and that button is gone — the section heading.
    useEffect(() => {
        if (confirmWasOpen.current && !confirmOpen) {
            const target = closeTriggerRef.current?.isConnected
                ? closeTriggerRef.current
                : headingRef.current;
            target?.focus();
        }
        confirmWasOpen.current = confirmOpen;
    }, [confirmOpen, state]);

    const confirmClose = async () => {
        if (closing) return;
        setClosing(true);
        setErrorKey(null);
        try {
            const result = await closeDeliveryAction(taskId);
            if (result.ok) {
                setLoad({ kind: 'ready', view: result.view, retryEscalationId: null });
            } else {
                setErrorKey(deliveryErrorKey(result.code));
            }
        } catch {
            setErrorKey('generic');
        } finally {
            setClosing(false);
            setConfirmOpen(false);
        }
    };

    // The same focus return for the fix-Task confirm: its button, or the heading once it is gone.
    useEffect(() => {
        if (fixConfirmWasOpen.current && !fixConfirmOpen) {
            const target = fixTriggerRef.current?.isConnected
                ? fixTriggerRef.current
                : headingRef.current;
            target?.focus();
        }
        fixConfirmWasOpen.current = fixConfirmOpen;
    }, [fixConfirmOpen, state]);

    const confirmFixTask = async () => {
        if (creatingFix) return;
        setCreatingFix(true);
        setErrorKey(null);
        try {
            const result = await createDeliveryFixTaskAction(taskId);
            if (result.ok) {
                setFixResult({ taskId: result.taskId, slug: result.slug, created: result.created });
                await read();
            } else {
                setErrorKey(deliveryErrorKey(result.code));
            }
        } catch {
            setErrorKey('generic');
        } finally {
            setCreatingFix(false);
            setFixConfirmOpen(false);
        }
    };

    const tryOnceMore = async (escalationId: string) => {
        if (retrying) return;
        setRetrying(true);
        setErrorKey(null);
        try {
            const result = await openDeliveryFollowUpAction(taskId, escalationId);
            if (result.ok) {
                setFollowUpOpened(true);
                await read();
            } else {
                setErrorKey(deliveryErrorKey(result.code));
            }
        } catch {
            setErrorKey('generic');
        } finally {
            setRetrying(false);
        }
    };

    const when = (iso: string | null | undefined) => {
        if (!iso) return null;
        const date = new Date(iso);
        return Number.isNaN(date.getTime())
            ? null
            : format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' });
    };

    const view = load.kind === 'ready' ? load.view : null;
    const retryEscalationId =
        load.kind === 'ready' && state && FAILED_STATES.has(state) ? load.retryEscalationId : null;
    const closable = Boolean(state && CLOSABLE_STATES.has(state));
    // While the change's Inbox item is open, Try once more IS the fix-Task offer.
    const fixable = Boolean(state && FAILED_STATES.has(state) && !retryEscalationId && !fixResult);
    const deployNow =
        view?.state === 'built' && view.canDeployNow === true && view.build && workId
            ? { workId, buildId: view.build.id }
            : null;
    const closeLabel =
        state && FAILED_STATES.has(state) ? t('closeAnyway') : t('closeWithoutDeploying');
    const chip: TaskDeliveryChipInput | null = view?.state
        ? {
              state: view.state,
              liveUrl: view.liveUrl,
              outcome: view.deployment?.outcome ?? null,
              liveWithWarnings: view.liveWithWarnings,
              carriedByLaterChange: view.carriedByLaterChange,
          }
        : null;

    return (
        <section
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5"
            data-testid="task-delivery-section"
            data-state={load.kind === 'ready' ? (state ?? 'untracked') : load.kind}
            aria-labelledby={`task-delivery-heading-${taskId}`}
        >
            <div className="flex items-center justify-between gap-3 mb-3">
                <h2
                    id={`task-delivery-heading-${taskId}`}
                    ref={headingRef}
                    tabIndex={-1}
                    className="text-sm font-medium text-text dark:text-text-dark focus:outline-none"
                >
                    {t('sectionTitle')}
                </h2>
                {chip && <TaskDeliveryChips delivery={chip} />}
            </div>
            {/* APW-08 T52 (FR-71) — progress and completion in a polite live region: the poll
                moves the chain, and a screen reader hears the chip's new state. Always mounted,
                so the region exists before its text changes. */}
            <p
                className="sr-only"
                role="status"
                aria-live="polite"
                data-testid="task-delivery-announcer"
            >
                {chip ? chipText(chip).spoken : ''}
            </p>

            {load.kind === 'loading' && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('loading')}</p>
            )}
            {load.kind === 'unavailable' && (
                <p
                    className="text-xs text-text-muted dark:text-text-muted-dark"
                    data-testid="task-delivery-unavailable"
                >
                    {t('unavailable')}
                </p>
            )}

            {view?.state && (
                <ol className="space-y-2 text-xs" data-testid="task-delivery-timeline">
                    {view.pullRequest && (
                        <TimelineRow
                            step="done"
                            testId="task-delivery-row-merged"
                            at={when(view.pullRequest.mergedAt)}
                        >
                            {(() => {
                                const label = view.pullRequest.base
                                    ? t('merged', {
                                          number: view.pullRequest.number,
                                          branch: view.pullRequest.base,
                                      })
                                    : t('mergedNoBranch', { number: view.pullRequest.number });
                                const href = safeHttpsUrl(view.pullRequest.url);
                                return href ? (
                                    <a
                                        href={href}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="hover:text-primary hover:underline"
                                    >
                                        {label}
                                    </a>
                                ) : (
                                    label
                                );
                            })()}
                        </TimelineRow>
                    )}

                    {view.build && (
                        <TimelineRow
                            step={buildStep(view.state)}
                            testId="task-delivery-row-build"
                            at={when(phaseAt(view, ['building', 'built', 'build_failed']))}
                            ariaLabel={
                                buildStep(view.state) === 'done'
                                    ? t('ariaBuildSucceeded')
                                    : undefined
                            }
                        >
                            <span>
                                {view.build.number != null
                                    ? t('build', {
                                          number: view.build.number,
                                          shortSha: view.build.commitSha.slice(0, 7),
                                      })
                                    : t('buildUnnumbered', {
                                          shortSha: view.build.commitSha.slice(0, 7),
                                      })}
                            </span>
                            {safeHttpsUrl(view.build.logsUrl) && (
                                <a
                                    href={safeHttpsUrl(view.build.logsUrl) ?? undefined}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    data-testid="task-delivery-build-logs"
                                    className="ms-2 text-text-muted hover:text-primary hover:underline"
                                >
                                    {t('buildLogs')} ↗
                                </a>
                            )}
                            {workId && (
                                <Link
                                    href={ROUTES.DASHBOARD_WORK_BUILDS(workId)}
                                    data-testid="task-delivery-builds-link"
                                    className="ms-2 text-text-muted hover:text-primary hover:underline"
                                >
                                    {t('openBuilds')}
                                </Link>
                            )}
                        </TimelineRow>
                    )}

                    {view.deployment && (
                        <TimelineRow
                            step={deploymentStep(view.state)}
                            testId="task-delivery-row-deployment"
                            at={when(phaseAt(view, ['deploying', 'deploy_failed', 'live']))}
                        >
                            <span>
                                {view.deployment.number != null
                                    ? t('deployment', { number: view.deployment.number })
                                    : t('deploymentUnnumbered')}
                            </span>
                            {workId && (
                                <Link
                                    href={ROUTES.DASHBOARD_WORK_DEPLOY(workId)}
                                    data-testid="task-delivery-deployments-link"
                                    className="ms-2 text-text-muted hover:text-primary hover:underline"
                                >
                                    {t('openDeployments')}
                                </Link>
                            )}
                        </TimelineRow>
                    )}

                    {view.state === 'live' && safeWebUrl(view.liveUrl) && (
                        <TimelineRow step="done" testId="task-delivery-row-live" at={null}>
                            <a
                                href={safeWebUrl(view.liveUrl) ?? undefined}
                                target="_blank"
                                rel="noopener noreferrer"
                                data-testid="task-delivery-live-url"
                                className="hover:text-primary hover:underline"
                            >
                                {t('liveAt', { url: view.liveUrl ?? '' })} ↗
                            </a>
                        </TimelineRow>
                    )}
                </ol>
            )}

            {view?.state === 'live' && view.liveWithWarnings && (
                <p className="mt-3 text-xs text-warning" data-testid="task-delivery-warnings">
                    {t('warnings')}
                </p>
            )}

            {view && view.followUps.length > 0 && (
                <ul className="mt-3 space-y-1 text-xs" data-testid="task-delivery-follow-ups">
                    {view.followUps.map((followUp) => (
                        <li key={followUp.taskId} data-testid="task-delivery-follow-up">
                            <Link
                                href={ROUTES.DASHBOARD_TASK(followUp.taskId)}
                                className="text-text-secondary dark:text-text-secondary-dark hover:text-primary hover:underline"
                            >
                                {t('followUpRow', {
                                    slug: followUp.slug,
                                    status: TASK_STATUS_KEYS.has(followUp.status)
                                        ? tStatus(followUp.status as never)
                                        : followUp.status,
                                })}
                            </Link>
                            {followUp.status === 'cancelled' && view.state === 'live' && (
                                <span className="ms-2 text-text-muted">
                                    {t('followUpCancelled')}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}

            {deployNow && (
                <div className="mt-4 space-y-2" data-testid="task-delivery-deploy-now">
                    <p className="text-xs text-text-muted dark:text-text-muted-dark">
                        {t('deployNowHint')}
                    </p>
                    <AppDeployNowButton
                        workId={deployNow.workId}
                        buildId={deployNow.buildId}
                        size="sm"
                        buttonClassName={PRIMARY_CTA}
                        onRequested={() => void read()}
                    />
                </div>
            )}

            {fixResult && (
                <p
                    className="mt-3 text-xs text-text-secondary dark:text-text-secondary-dark"
                    role="status"
                    data-testid="task-delivery-fix-task-result"
                    data-created={fixResult.created ? 'true' : 'false'}
                >
                    {fixResult.created
                        ? fixResult.slug
                            ? t('fixTaskCreated', { slug: fixResult.slug })
                            : t('fixTaskCreatedUnnamed')
                        : t('fixTaskExists', { slug: fixResult.slug ?? '' })}{' '}
                    <Link
                        href={ROUTES.DASHBOARD_TASK(fixResult.taskId)}
                        className="font-medium text-primary hover:underline dark:text-primary-dark"
                        data-testid="task-delivery-fix-task-link"
                    >
                        {t('openFixTask')}
                    </Link>
                </p>
            )}

            {followUpOpened && (
                <p
                    className="mt-3 text-xs text-text-secondary"
                    role="status"
                    data-testid="task-delivery-follow-up-opened"
                >
                    {t('followUpOpened')}
                </p>
            )}
            {errorKey && (
                <p
                    className="mt-3 text-xs text-danger"
                    role="alert"
                    data-testid="task-delivery-error"
                    data-code={errorKey}
                >
                    {t(`errors.${errorKey}`)}
                </p>
            )}
            {pollingStopped && isDeliveryOpen(state) && (
                <p
                    className="mt-3 text-xs text-text-muted"
                    role="status"
                    data-testid="task-delivery-polling-stopped"
                >
                    {t('pollingStopped')}
                </p>
            )}

            {(closable || retryEscalationId || fixable) && (
                <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                    {fixable && (
                        <Button
                            ref={fixTriggerRef}
                            type="button"
                            size="sm"
                            data-testid="task-delivery-create-fix-task"
                            onClick={() => {
                                setErrorKey(null);
                                setFixConfirmOpen(true);
                            }}
                            className={PRIMARY_CTA}
                        >
                            {t('createFixTask')}
                        </Button>
                    )}
                    {retryEscalationId && (
                        <>
                            <span className="text-xs text-text-muted dark:text-text-muted-dark me-auto">
                                {t('tryOnceMoreHint')}
                            </span>
                            <Button
                                type="button"
                                size="sm"
                                data-testid="task-delivery-retry"
                                loading={retrying}
                                onClick={() => void tryOnceMore(retryEscalationId)}
                                className="dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
                            >
                                {t('tryOnceMore')}
                            </Button>
                        </>
                    )}
                    {closable && (
                        <Button
                            ref={closeTriggerRef}
                            type="button"
                            variant="secondary"
                            size="sm"
                            data-testid="task-delivery-close"
                            onClick={() => {
                                setErrorKey(null);
                                setConfirmOpen(true);
                            }}
                        >
                            {closeLabel}
                        </Button>
                    )}
                </div>
            )}

            <Dialog
                open={confirmOpen}
                onOpenChange={(next) =>
                    next ? undefined : closing ? undefined : setConfirmOpen(false)
                }
            >
                <DialogContent className="max-w-md">
                    <DialogClose onClose={() => (closing ? undefined : setConfirmOpen(false))} />
                    <DialogHeader className="mb-0">
                        <DialogTitle className="text-base font-semibold text-text dark:text-text-dark pr-6">
                            {t('closeConfirm')}
                        </DialogTitle>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            data-testid="task-delivery-keep-open"
                            disabled={closing}
                            onClick={() => setConfirmOpen(false)}
                        >
                            {t('keepOpen')}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            data-testid="task-delivery-confirm-close"
                            loading={closing}
                            onClick={() => void confirmClose()}
                            className="dark:bg-white dark:text-gray-900 dark:hover:bg-gray-100"
                        >
                            {closing ? t('closing') : t('closeAnyway')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog
                open={fixConfirmOpen}
                onOpenChange={(next) =>
                    next ? undefined : creatingFix ? undefined : setFixConfirmOpen(false)
                }
            >
                <DialogContent className="max-w-md">
                    <DialogClose
                        onClose={() => (creatingFix ? undefined : setFixConfirmOpen(false))}
                    />
                    <DialogHeader className="mb-0">
                        <DialogTitle className="text-base font-semibold text-text dark:text-text-dark pr-6">
                            {t('createFixTaskConfirm')}
                        </DialogTitle>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            data-testid="task-delivery-fix-task-cancel"
                            disabled={creatingFix}
                            onClick={() => setFixConfirmOpen(false)}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            data-testid="task-delivery-confirm-fix-task"
                            loading={creatingFix}
                            onClick={() => void confirmFixTask()}
                            className={PRIMARY_CTA}
                        >
                            {creatingFix ? t('creatingFixTask') : t('createFixTask')}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </section>
    );
}

function TimelineRow({
    step,
    testId,
    at,
    ariaLabel,
    children,
}: {
    step: Step;
    testId: string;
    at: string | null;
    ariaLabel?: string;
    children: ReactNode;
}) {
    const Icon = step === 'neutral' ? CircleDashed : STEP_ICONS[step];
    return (
        <li className="flex items-start gap-2" data-testid={testId} data-step={step}>
            <Icon
                className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', STEP_TONES[step])}
                aria-label={ariaLabel}
                aria-hidden={ariaLabel ? undefined : true}
            />
            <div className="min-w-0 flex-1 text-text dark:text-text-dark">{children}</div>
            {at && <span className="shrink-0 text-text-muted dark:text-text-muted-dark">{at}</span>}
        </li>
    );
}
