'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import {
    FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH,
    FLEET_SESSION_FIRST_MESSAGE_MIN_LENGTH,
    type FleetSessionView,
    type FleetTaskHandoffOptions,
} from '@ever-works/contracts';
import { createCheckoutAction } from '@/app/actions/fleet-checkouts';
import {
    getHandoffCheckoutAction,
    getTaskHandoffOptionsAction,
} from '@/app/actions/fleet-task-handoff';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { sessionsClient } from '../sessions/sessions.client';
import { CheckoutChoice } from './CheckoutChoice';
import { ComputerPicker } from './ComputerPicker';
import { IdentityLine } from './IdentityLine';
import {
    checkoutCreateRequest,
    choiceStillOffered,
    HANDOFF_ACK_WAIT_MS,
    HANDOFF_CHECKOUT_WAIT_MS,
    HANDOFF_POLL_MS,
    handoffStartRequest,
    initialCheckoutChoice,
    initialComputerId,
    nothingSelectable,
    selectedAgent,
    type HandoffCheckoutChoice,
} from './task-handoff.shared';

type Phase =
    | { kind: 'idle' }
    | { kind: 'checkout' }
    | { kind: 'starting' }
    | { kind: 'waiting'; session: FleetSessionView; overdue: boolean }
    | { kind: 'started'; session: FleetSessionView };

interface HandoffError {
    code: string | null;
    hint: string | null;
    sessionId?: string | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Tasks on computers (FL-15 P1, spec §5.2) — **Fix with an agent on this
 * computer**: one dialog that picks the computer (honouring the Agent's pin,
 * FR-3), the Agent (Run with agent's candidates, FR-4), the checkout (a new
 * worktree on the Task's branch, an existing checkout, a fresh clone — FR-5)
 * and a first message prefilled from the Task (FR-7), states the cost in
 * prose (FR-8), then starts an Agent session through FL-04's one start path
 * with the Task named (FR-6).
 *
 * A new worktree or a fresh clone is made first through FL-14's create and
 * waited on until it is ready; the session then starts in it. After the
 * start is accepted the dialog waits for the computer to acknowledge it and,
 * after 40 seconds, says so with Keep waiting / Close (spec U9) — nothing is
 * started twice.
 */
export function FixOnComputerDialog({
    taskId,
    taskSlug,
    open,
    onOpenChange,
}: {
    taskId: string;
    taskSlug: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations('fleet.taskHandoff');
    const router = useRouter();
    const [options, setOptions] = useState<FleetTaskHandoffOptions | null>(null);
    const [loadError, setLoadError] = useState<HandoffError | null>(null);
    const [loading, setLoading] = useState(false);
    const [agentId, setAgentId] = useState<string | null>(null);
    const [nodeId, setNodeId] = useState<string | null>(null);
    const [choice, setChoice] = useState<HandoffCheckoutChoice>({ mode: 'none' });
    const [message, setMessage] = useState('');
    const [edited, setEdited] = useState(false);
    const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
    const [error, setError] = useState<HandoffError | null>(null);
    const alive = useRef(true);

    useEffect(() => {
        alive.current = open;
        return () => {
            alive.current = false;
        };
    }, [open]);

    const load = useCallback(
        async (forAgent: string | null) => {
            setLoading(true);
            setLoadError(null);
            const result = await getTaskHandoffOptionsAction(taskId, forAgent);
            if (!alive.current) return;
            setLoading(false);
            if (!result.success) {
                setLoadError({ code: result.code, hint: result.hint });
                return;
            }
            const data = result.data;
            setOptions(data);
            setAgentId(data.agentId);
            const next = (current: string | null) =>
                current && data.computers.some((row) => row.nodeId === current && row.selectable)
                    ? current
                    : initialComputerId(data.computers);
            setNodeId((current) => {
                const chosen = next(current);
                const step = data.checkouts.find((row) => row.nodeId === chosen);
                setChoice((previous) =>
                    chosen &&
                    choiceStillOffered(previous, step, data.task) &&
                    previous.mode !== 'none'
                        ? previous
                        : initialCheckoutChoice(step, data.task),
                );
                return chosen;
            });
            setMessage((current) => (edited && current ? current : data.firstMessage));
        },
        [taskId, edited],
    );

    useEffect(() => {
        if (!open) return;
        setPhase({ kind: 'idle' });
        setError(null);
        setEdited(false);
        void load(null);
        // Load once per opening; re-judging for another Agent goes through `pickAgent`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, taskId]);

    const agent = options ? selectedAgent({ ...options, agentId }) : null;
    const computer = options?.computers.find((row) => row.nodeId === nodeId) ?? null;
    const step = options?.checkouts.find((row) => row.nodeId === nodeId);
    const busy = phase.kind === 'checkout' || phase.kind === 'starting';
    const trimmed = message.trim();
    const messageOk =
        trimmed.length >= FLEET_SESSION_FIRST_MESSAGE_MIN_LENGTH &&
        message.length <= FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH;
    const canStart =
        !!options &&
        !!agent &&
        !!computer?.selectable &&
        !options.killSwitch &&
        messageOk &&
        phase.kind === 'idle';
    const none = options ? nothingSelectable(options.computers) : false;

    const pickAgent = (id: string) => {
        setAgentId(id);
        void load(id);
    };

    const pickNode = (id: string) => {
        setNodeId(id);
        if (options) {
            const nextStep = options.checkouts.find((row) => row.nodeId === id);
            setChoice(initialCheckoutChoice(nextStep, options.task));
        }
    };

    const waitForAck = useCallback(
        async (session: FleetSessionView) => {
            let current = session;
            const since = Date.now();
            setPhase({ kind: 'waiting', session: current, overdue: false });
            while (alive.current) {
                if (current.state !== 'starting') {
                    setPhase({ kind: 'started', session: current });
                    router.refresh();
                    return;
                }
                if (Date.now() - since > HANDOFF_ACK_WAIT_MS) {
                    setPhase({ kind: 'waiting', session: current, overdue: true });
                    return;
                }
                await sleep(HANDOFF_POLL_MS);
                const again = await sessionsClient.get(current.id);
                if (again.ok) current = again.data;
            }
        },
        [router],
    );

    const keepWaiting = () => {
        if (phase.kind === 'waiting') void waitForAck(phase.session);
    };

    const onSubmit = async (event: FormEvent) => {
        event.preventDefault();
        if (!canStart || !options || !agent || !computer) return;
        setError(null);
        let checkout: { id: string; path: string } | null = null;
        if (choice.mode === 'existing') {
            const ref = [...(step?.matching ?? []), ...(step?.others ?? [])].find(
                (row) => row.checkoutId === choice.checkoutId,
            );
            if (ref) checkout = { id: ref.checkoutId, path: ref.path };
        }
        const create = checkoutCreateRequest(computer.nodeId, choice, options.task);
        if (create) {
            setPhase({ kind: 'checkout' });
            const created = await createCheckoutAction(create);
            if (!alive.current) return;
            if (!created.success) {
                setPhase({ kind: 'idle' });
                setError({ code: created.code, hint: created.hint ?? t('dialog.checkoutFailed') });
                return;
            }
            let view = created.data.checkout;
            const deadline = Date.now() + HANDOFF_CHECKOUT_WAIT_MS;
            while (view.state === 'creating' && Date.now() < deadline && alive.current) {
                await sleep(HANDOFF_POLL_MS);
                const again = await getHandoffCheckoutAction(view.id);
                if (again.success) view = again.data;
            }
            if (!alive.current) return;
            if (view.state !== 'ready') {
                setPhase({ kind: 'idle' });
                setError({
                    code: 'operation_failed',
                    hint: t('dialog.checkoutNotReady', { state: view.state }),
                });
                return;
            }
            checkout = { id: view.id, path: view.path };
        }
        setPhase({ kind: 'starting' });
        const result = await sessionsClient.start(
            computer.nodeId,
            handoffStartRequest({ taskId, agent, firstMessage: message, checkout }),
        );
        if (!alive.current) return;
        if (!result.ok) {
            setPhase({ kind: 'idle' });
            const sessionId =
                typeof result.error.details?.sessionId === 'string'
                    ? result.error.details.sessionId
                    : null;
            setError({ code: result.error.code, hint: result.error.hint, sessionId });
            return;
        }
        void waitForAck(result.data);
    };

    const costLine = useMemo(() => {
        if (!agent || !computer) return null;
        const values = {
            agent: agent.name,
            node: computer.name,
            slug: taskSlug,
            model: agent.modelId ?? '',
        };
        return agent.modelId ? t('cost', values) : t('costNoModel', values);
    }, [agent, computer, taskSlug, t]);

    return (
        <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
            <DialogContent className="max-w-2xl">
                <form onSubmit={onSubmit} data-testid="fleet-handoff-dialog">
                    <DialogHeader>
                        <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                            {t('dialog.title')}
                        </DialogTitle>
                        {options && (
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('dialog.subtitle', {
                                    slug: options.task.slug,
                                    title: options.task.title,
                                })}
                            </p>
                        )}
                    </DialogHeader>

                    <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
                        {options?.killSwitch && (
                            <p
                                role="status"
                                className="rounded-md bg-warning/10 px-3 py-2 text-sm text-warning"
                            >
                                {t('dialog.killSwitch')}
                            </p>
                        )}
                        {loadError && (
                            <p role="alert" className="text-sm text-danger">
                                {t('dialog.loadFailed')} {loadError.hint ?? ''}
                            </p>
                        )}

                        <section className="space-y-1.5">
                            <h3 className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                {t('dialog.computer')}
                            </h3>
                            <ComputerPicker
                                computers={options?.computers ?? []}
                                agent={agent}
                                selectedId={nodeId}
                                onSelect={pickNode}
                                loading={loading && !options}
                            />
                            {options && none && agent && (
                                <p
                                    className="text-sm text-warning"
                                    role="status"
                                    data-testid="fleet-handoff-none"
                                >
                                    {t('dialog.noComputer', { agent: agent.name })}{' '}
                                    {t('dialog.runWithAgentHint')}
                                </p>
                            )}
                        </section>

                        <section className="space-y-1.5">
                            <h3 className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                {t('dialog.agent')}
                            </h3>
                            {options && options.agents.length === 0 ? (
                                <p className="text-sm text-warning">{t('dialog.noAgent')}</p>
                            ) : (
                                <select
                                    value={agentId ?? ''}
                                    onChange={(event) => pickAgent(event.target.value)}
                                    disabled={!options || busy}
                                    className="w-full rounded-md border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark px-2 py-1.5 text-sm"
                                    data-testid="fleet-handoff-agent"
                                >
                                    {(options?.agents ?? []).map((candidate) => (
                                        <option key={candidate.id} value={candidate.id}>
                                            {candidate.name} —{' '}
                                            {t(
                                                `sources.${candidate.source === 'work-default' ? 'workDefault' : candidate.source}`,
                                            )}
                                        </option>
                                    ))}
                                </select>
                            )}
                        </section>

                        {options && computer && (
                            <section className="space-y-1.5">
                                <h3 className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('dialog.checkout')}
                                </h3>
                                {options.task.pullRequest && (
                                    <p
                                        className={
                                            options.task.pullRequest.readOnly
                                                ? 'text-xs text-warning'
                                                : 'text-xs text-text-muted'
                                        }
                                        data-testid="fleet-handoff-pr"
                                    >
                                        {options.task.pullRequest.readOnly
                                            ? t('pr.forkReadOnly', { agent: agent?.name ?? '' })
                                            : t('pr.head', {
                                                  number: options.task.pullRequest.number,
                                                  branch: options.task.pullRequest.headRef ?? '',
                                              })}
                                    </p>
                                )}
                                <CheckoutChoice
                                    step={step}
                                    task={options.task}
                                    value={choice}
                                    onChange={setChoice}
                                    nodeName={computer.name}
                                />
                            </section>
                        )}

                        <section className="space-y-1.5">
                            <label className="block space-y-1">
                                <span className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('dialog.firstMessage')}
                                </span>
                                <textarea
                                    value={message}
                                    onChange={(event) => {
                                        setMessage(event.target.value);
                                        setEdited(true);
                                    }}
                                    rows={7}
                                    maxLength={FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH}
                                    disabled={!options || busy}
                                    className="w-full rounded-md border border-border dark:border-border-dark bg-card dark:bg-card-primary-dark p-2 text-sm font-mono"
                                    data-testid="fleet-handoff-message"
                                />
                            </label>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('dialog.firstMessageHint')}
                            </p>
                        </section>

                        {computer?.selectable && (
                            <IdentityLine
                                key={computer.nodeId}
                                nodeId={computer.nodeId}
                                nodeName={computer.name}
                            />
                        )}

                        {costLine && (
                            <p
                                className="text-xs text-text-muted dark:text-text-muted-dark"
                                data-testid="fleet-handoff-cost"
                            >
                                {costLine}
                            </p>
                        )}

                        {phase.kind === 'checkout' && computer && (
                            <p role="status" className="flex items-center gap-2 text-sm">
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                                {t('dialog.creatingCheckout', { node: computer.name })}
                            </p>
                        )}
                        {phase.kind === 'waiting' && computer && (
                            <div
                                role="status"
                                className="space-y-2 text-sm"
                                data-testid="fleet-handoff-waiting"
                            >
                                <p className="flex items-center gap-2">
                                    {!phase.overdue && (
                                        <Loader2
                                            className="h-4 w-4 animate-spin"
                                            aria-hidden="true"
                                        />
                                    )}
                                    {phase.overdue
                                        ? t('dialog.notStartedYet', { node: computer.name })
                                        : t('dialog.waiting', { node: computer.name })}
                                </p>
                                <div className="flex gap-2">
                                    {phase.overdue && (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="secondary"
                                            onClick={keepWaiting}
                                        >
                                            {t('dialog.keepWaiting')}
                                        </Button>
                                    )}
                                    <Link
                                        href={ROUTES.DASHBOARD_FLEET_SESSION(phase.session.id)}
                                        className="text-sm text-primary hover:underline"
                                    >
                                        {t('dialog.openSession')}
                                    </Link>
                                </div>
                            </div>
                        )}
                        {phase.kind === 'started' && computer && agent && (
                            <p
                                role="status"
                                className="text-sm text-emerald-600"
                                data-testid="fleet-handoff-started"
                            >
                                {t('dialog.started', { agent: agent.name, node: computer.name })}{' '}
                                <Link
                                    href={ROUTES.DASHBOARD_FLEET_SESSION(phase.session.id)}
                                    className="text-primary hover:underline"
                                >
                                    {t('dialog.openSession')}
                                </Link>
                            </p>
                        )}

                        {error && (
                            <p
                                role="alert"
                                className="text-sm text-danger"
                                data-testid="fleet-handoff-error"
                            >
                                {error.code === 'busy' && agent
                                    ? t('dialog.busy', { agent: agent.name })
                                    : (error.hint ?? t('dialog.failed'))}{' '}
                                {error.sessionId && (
                                    <Link
                                        href={ROUTES.DASHBOARD_FLEET_SESSION(error.sessionId)}
                                        className="text-primary hover:underline"
                                    >
                                        {t('dialog.openSession')}
                                    </Link>
                                )}
                            </p>
                        )}
                        {!error && phase.kind === 'idle' && options?.activeSessionId && (
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('dialog.alreadyWorking', { agent: agent?.name ?? '' })}{' '}
                                <Link
                                    href={ROUTES.DASHBOARD_FLEET_SESSION(options.activeSessionId)}
                                    className="text-primary hover:underline"
                                >
                                    {t('dialog.openSession')}
                                </Link>
                            </p>
                        )}
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => onOpenChange(false)}
                            disabled={busy}
                        >
                            {phase.kind === 'started' || phase.kind === 'waiting'
                                ? t('dialog.close')
                                : t('dialog.cancel')}
                        </Button>
                        {phase.kind !== 'started' && phase.kind !== 'waiting' && (
                            <Button
                                type="submit"
                                disabled={!canStart}
                                data-testid="fleet-handoff-start"
                            >
                                {busy ? t('dialog.starting') : t('dialog.start')}
                            </Button>
                        )}
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
