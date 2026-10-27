'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
    FLEET_SESSION_CWD_MAX_LENGTH,
    FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH,
    FLEET_SESSION_FIRST_MESSAGE_MIN_LENGTH,
    FLEET_SESSION_TITLE_MAX_LENGTH,
    isFleetAgentSessionProvider,
    isFleetSessionAgentProvider,
    type FleetNodeView,
    type FleetSessionKind,
    type FleetSessionStartableProvider,
    type FleetSessionView,
} from '@ever-works/contracts';
import { listSessionAgentsAction } from '@/app/actions/fleet-sessions';
import { createCheckoutAction } from '@/app/actions/fleet-checkouts';
import { getHandoffCheckoutAction } from '@/app/actions/fleet-task-handoff';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { sessionsClient } from './sessions.client';
import { SessionWhereStep, type SessionWhereChoice } from './SessionWhereStep';

/** How long the dialog waits for a new worktree or clone to become ready (FL-06 S1: seconds on a warm repository). */
const CHECKOUT_WAIT_MS = 120_000;
const CHECKOUT_POLL_MS = 2_000;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
import {
    canStartAgentSession,
    canStartOwnerSession,
    defaultProvider,
    errorField,
    providerInstalled,
    providerKey,
    SESSION_DIALOG_PROVIDERS,
    type SessionErrorRead,
} from './sessions.shared';

/**
 * Sessions on computers (FL-04, spec §5.2, FR-12 … FR-17, FR-42 … FR-49) —
 * "New session" on one computer: who → what → where → first message → start.
 *
 *  - **Who**: You (an owner session — runs as you, in your login; needs
 *    `--manage`) or one of your Agents (P2 — isolated, owns a Run; needs
 *    `--work`). A computer that cannot take one says why, in words.
 *  - **What**: Claude Code, Codex, a shell — a CLI the computer does not
 *    advertise is greyed "not installed on build-01"; an Agent drives a CLI,
 *    never a bare shell.
 *  - **Where**: a folder on the computer, with the folders of its last ten
 *    sessions as one-click chips. "In a new worktree" waits for Checkouts.
 *  - **First message**: optional for your own CLI session, required (3–4 000
 *    characters) for an Agent's.
 *  - **The cost sentence**: your own login, or the Agent's isolated Run.
 *
 * A refusal keeps every field and marks the one it names; success opens the
 * session page (an Agent session may still be waiting for a free slot there).
 * `initialKind` / `initialAgentId` preselect (the Agent page's "New session").
 */
export function SessionStartDialog({
    open,
    onOpenChange,
    node,
    onStarted,
    initialKind,
    initialAgentId,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    node: FleetNodeView;
    onStarted?: (view: FleetSessionView) => void;
    initialKind?: FleetSessionKind;
    initialAgentId?: string;
}) {
    const t = useTranslations('fleet.sessions');
    const router = useRouter();
    const ownerAllowed = canStartOwnerSession(node);
    const agentAllowed = canStartAgentSession(node);
    const [who, setWho] = useState<FleetSessionKind>(
        initialKind ?? (ownerAllowed || !agentAllowed ? 'owner' : 'agent'),
    );
    const [provider, setProvider] = useState<FleetSessionStartableProvider>(() =>
        defaultProvider(node),
    );
    const [cwd, setCwd] = useState('');
    const [title, setTitle] = useState('');
    const [firstMessage, setFirstMessage] = useState('');
    const [recent, setRecent] = useState<string[]>([]);
    const [agents, setAgents] = useState<{ id: string; name: string }[] | null>(null);
    const [agentId, setAgentId] = useState(initialAgentId ?? '');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<SessionErrorRead | null>(null);
    // FL-06 (spec FR-2): the Where step's checkout choice; `folder` is FL-04's free folder.
    const [where, setWhere] = useState<SessionWhereChoice>({ mode: 'folder' });
    const [creatingCheckout, setCreatingCheckout] = useState(false);

    useEffect(() => {
        if (!open) return;
        setError(null);
        let cancelled = false;
        void sessionsClient.listForNode(node.id, { limit: 1 }).then((result) => {
            if (cancelled || !result.ok) return;
            const folders = result.data.recentFolders ?? [];
            setRecent(folders);
            setCwd((current) => current || folders[0] || '');
        });
        return () => {
            cancelled = true;
        };
    }, [open, node.id]);

    useEffect(() => {
        if (!open || who !== 'agent' || agents !== null) return;
        let cancelled = false;
        void listSessionAgentsAction().then((list) => {
            if (cancelled) return;
            setAgents(list);
            setAgentId((current) => current || list[0]?.id || '');
        });
        return () => {
            cancelled = true;
        };
    }, [open, who, agents]);

    // An Agent drives a CLI: leaving "You" for "Agent" moves off the shell.
    useEffect(() => {
        if (who === 'agent' && !isFleetAgentSessionProvider(provider)) {
            const cli = SESSION_DIALOG_PROVIDERS.find(
                (option) => isFleetAgentSessionProvider(option) && providerInstalled(node, option),
            );
            if (cli) setProvider(cli);
        }
    }, [who, provider, node]);

    const field = errorField(error);
    const agentCli = isFleetSessionAgentProvider(provider);
    const providerName = t(`providers.${providerKey(provider)}`);
    const agentName = agents?.find((agent) => agent.id === agentId)?.name ?? '';
    const messageLength = firstMessage.trim().length;
    const agentReady =
        who !== 'agent' ||
        (agentAllowed &&
            agentId.length > 0 &&
            isFleetAgentSessionProvider(provider) &&
            messageLength >= FLEET_SESSION_FIRST_MESSAGE_MIN_LENGTH &&
            firstMessage.length <= FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH);
    const canSubmit =
        (who === 'owner' ? ownerAllowed : agentAllowed) &&
        agentReady &&
        !pending &&
        (where.mode !== 'folder' ||
            (cwd.trim().length > 0 && cwd.length <= FLEET_SESSION_CWD_MAX_LENGTH)) &&
        providerInstalled(node, provider);

    /**
     * FL-06 (spec FR-1, FR-2, S1): the checkout the session starts in — the
     * chosen one, or a new worktree / clone created through Checkouts first
     * and waited for until it is ready (one create path, one start path).
     */
    const resolveCheckout = async (): Promise<{ id: string; path: string } | null | 'failed'> => {
        if (where.mode === 'folder') return null;
        if (where.mode === 'existing') return { id: where.checkoutId, path: where.path };
        setCreatingCheckout(true);
        const created = await createCheckoutAction({
            nodeId: node.id,
            source:
                where.mode === 'worktree'
                    ? { kind: 'worktree', parentCheckoutId: where.parentCheckoutId }
                    : { kind: 'clone', repoUrl: where.repoUrl },
            branch: where.branch,
        });
        if (!created.success) {
            setCreatingCheckout(false);
            setError({
                code: (created.code ?? 'internal') as SessionErrorRead['code'],
                hint: created.hint,
                details: created.details ?? {},
                status: 0,
            });
            return 'failed';
        }
        let view = created.data.checkout;
        const deadline = Date.now() + CHECKOUT_WAIT_MS;
        while (view.state === 'creating' && Date.now() < deadline) {
            await sleep(CHECKOUT_POLL_MS);
            const again = await getHandoffCheckoutAction(view.id);
            if (again.success) view = again.data;
        }
        setCreatingCheckout(false);
        if (view.state !== 'ready') {
            setError({
                code: 'operation_failed',
                hint:
                    view.lastCommand?.stderrHead ??
                    t('start.checkoutNotReady', { state: view.state }),
                details: {},
                status: 0,
            });
            return 'failed';
        }
        return { id: view.id, path: view.path };
    };

    const onSubmit = async (event: FormEvent) => {
        event.preventDefault();
        if (!canSubmit) return;
        setPending(true);
        setError(null);
        const checkout = await resolveCheckout();
        if (checkout === 'failed') {
            setPending(false);
            return;
        }
        const result = await sessionsClient.start(node.id, {
            kind: who,
            provider,
            cwd: checkout ? checkout.path : cwd.trim(),
            ...(checkout ? { checkoutId: checkout.id } : {}),
            ...(title.trim() ? { title: title.trim() } : {}),
            ...(who === 'agent' ? { agentId } : {}),
            ...(agentCli && firstMessage.trim() ? { firstMessage } : {}),
        });
        setPending(false);
        if (!result.ok) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
        onStarted?.(result.data);
        router.push(ROUTES.DASHBOARD_FLEET_SESSION(result.data.id));
    };

    const radio = (selected: boolean, disabled: boolean) =>
        cn(
            'flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-left',
            selected ? 'border-primary bg-primary/5' : 'border-border dark:border-border-dark',
            disabled && 'opacity-50 cursor-not-allowed',
        );

    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent className="max-w-xl">
                <form onSubmit={onSubmit} data-testid="fleet-session-start-dialog">
                    <DialogHeader>
                        <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                            {t('start.title')} · {node.name}
                        </DialogTitle>
                    </DialogHeader>

                    <div className="space-y-4">
                        <fieldset className="space-y-2">
                            <legend className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                {t('start.who')}
                            </legend>
                            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup">
                                <button
                                    type="button"
                                    role="radio"
                                    aria-checked={who === 'owner'}
                                    disabled={!ownerAllowed}
                                    onClick={() => setWho('owner')}
                                    className={radio(who === 'owner', !ownerAllowed)}
                                    data-testid="fleet-session-start-who-owner"
                                >
                                    {t('start.you')}
                                </button>
                                <button
                                    type="button"
                                    role="radio"
                                    aria-checked={who === 'agent'}
                                    disabled={!agentAllowed}
                                    onClick={() => setWho('agent')}
                                    className={radio(who === 'agent', !agentAllowed)}
                                    data-testid="fleet-session-start-who-agent"
                                >
                                    {t('start.agent')}
                                </button>
                            </div>
                            {who === 'owner' && !ownerAllowed && (
                                <p className="text-xs text-warning" role="status">
                                    {t('start.noConsent', { node: node.name })}
                                </p>
                            )}
                            {!agentAllowed && (
                                <p
                                    className="text-xs text-text-muted dark:text-text-muted-dark"
                                    role="status"
                                >
                                    {t('states.consentWork')}
                                </p>
                            )}
                            {who === 'agent' && (
                                <label className="block space-y-1 text-sm">
                                    <span className="text-text-muted dark:text-text-muted-dark">
                                        {t('start.agentPick')}
                                    </span>
                                    {agents !== null && agents.length === 0 ? (
                                        <span className="block text-xs text-warning">
                                            {t('start.noAgents')}
                                        </span>
                                    ) : (
                                        <select
                                            value={agentId}
                                            onChange={(event) => setAgentId(event.target.value)}
                                            aria-invalid={field === 'agentId'}
                                            className={cn(
                                                'w-full rounded-md border bg-transparent px-3 py-2 text-sm',
                                                field === 'agentId'
                                                    ? 'border-danger'
                                                    : 'border-border dark:border-border-dark',
                                            )}
                                            data-testid="fleet-session-start-agent"
                                        >
                                            {(agents ?? []).map((agent) => (
                                                <option key={agent.id} value={agent.id}>
                                                    {agent.name}
                                                </option>
                                            ))}
                                        </select>
                                    )}
                                </label>
                            )}
                        </fieldset>

                        <fieldset className="space-y-2">
                            <legend className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                {t('start.what')}
                            </legend>
                            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
                                {SESSION_DIALOG_PROVIDERS.map((option) => {
                                    const installed = providerInstalled(node, option);
                                    const forAgent =
                                        who !== 'agent' || isFleetAgentSessionProvider(option);
                                    const usable = installed && forAgent;
                                    return (
                                        <button
                                            key={option}
                                            type="button"
                                            role="radio"
                                            aria-checked={provider === option}
                                            disabled={!usable}
                                            onClick={() => setProvider(option)}
                                            className={radio(provider === option, !usable)}
                                            data-testid={`fleet-session-start-provider-${option}`}
                                        >
                                            <span>
                                                {t(`providers.${providerKey(option)}`)}
                                                {!installed && (
                                                    <span className="block text-xs text-text-muted dark:text-text-muted-dark">
                                                        {t('start.notInstalled', {
                                                            node: node.name,
                                                        })}
                                                    </span>
                                                )}
                                                {installed && !forAgent && (
                                                    <span className="block text-xs text-text-muted dark:text-text-muted-dark">
                                                        {t('start.agentShellNot')}
                                                    </span>
                                                )}
                                            </span>
                                        </button>
                                    );
                                })}
                            </div>
                        </fieldset>

                        <fieldset className="space-y-2">
                            <legend className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                {t('start.where')}
                            </legend>
                            {/* FL-06 (spec FR-2, §5.6): a checkout, then Existing · New worktree · Fresh clone. */}
                            <SessionWhereStep
                                nodeId={node.id}
                                nodeName={node.name}
                                kind={who}
                                agentId={who === 'agent' ? agentId || null : null}
                                firstMessage={firstMessage}
                                title={title}
                                cwd={cwd}
                                onCwdChange={setCwd}
                                onChange={setWhere}
                            />
                            <label className="block space-y-1 text-sm">
                                <span className="text-text-muted dark:text-text-muted-dark">
                                    {t('start.folderLabel', { node: node.name })}
                                </span>
                                <input
                                    value={cwd}
                                    onChange={(event) => setCwd(event.target.value)}
                                    placeholder={t('start.folderPlaceholder')}
                                    maxLength={FLEET_SESSION_CWD_MAX_LENGTH}
                                    aria-invalid={field === 'cwd'}
                                    className={cn(
                                        'w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm',
                                        field === 'cwd'
                                            ? 'border-danger'
                                            : 'border-border dark:border-border-dark',
                                    )}
                                    data-testid="fleet-session-start-cwd"
                                />
                            </label>
                            {recent.length > 0 && (
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {t('start.recent')}
                                    </span>
                                    {recent.map((folder) => (
                                        <button
                                            key={folder}
                                            type="button"
                                            onClick={() => setCwd(folder)}
                                            className="rounded-full border border-border dark:border-border-dark px-2 py-0.5 font-mono text-xs hover:bg-card-hover dark:hover:bg-card-hover-dark"
                                        >
                                            {folder}
                                        </button>
                                    ))}
                                </div>
                            )}
                            {where.mode === 'folder' ? (
                                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                    {t('start.inFolder')} · {t('start.worktreeLater')}
                                </p>
                            ) : null}
                        </fieldset>

                        <label className="block space-y-1 text-sm">
                            <span className="text-text-muted dark:text-text-muted-dark">
                                {t('start.sessionTitle')}
                            </span>
                            <input
                                value={title}
                                onChange={(event) => setTitle(event.target.value)}
                                placeholder={t('start.sessionTitlePlaceholder')}
                                maxLength={FLEET_SESSION_TITLE_MAX_LENGTH}
                                className="w-full rounded-md border border-border dark:border-border-dark bg-transparent px-3 py-2 text-sm"
                                data-testid="fleet-session-start-title"
                            />
                        </label>

                        {agentCli && (
                            <label className="block space-y-1 text-sm">
                                <span className="text-text-muted dark:text-text-muted-dark">
                                    {t('start.firstMessage')}
                                </span>
                                <textarea
                                    value={firstMessage}
                                    onChange={(event) => setFirstMessage(event.target.value)}
                                    maxLength={FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH}
                                    rows={3}
                                    required={who === 'agent'}
                                    aria-invalid={field === 'firstMessage'}
                                    className={cn(
                                        'w-full rounded-md border bg-transparent px-3 py-2 text-sm',
                                        field === 'firstMessage'
                                            ? 'border-danger'
                                            : 'border-border dark:border-border-dark',
                                    )}
                                    data-testid="fleet-session-start-first-message"
                                />
                                <span className="block text-xs text-text-muted dark:text-text-muted-dark">
                                    {who === 'agent'
                                        ? t('start.firstMessageRequired')
                                        : t('start.firstMessageHint', { provider: providerName })}
                                </span>
                            </label>
                        )}

                        <p
                            className="text-xs text-text-muted dark:text-text-muted-dark"
                            data-testid="fleet-session-start-cost"
                        >
                            {who === 'agent'
                                ? t('start.costAgent', {
                                      agent: agentName || t('kinds.agent'),
                                      node: node.name,
                                  })
                                : provider === 'shell'
                                  ? t('start.costShell', { node: node.name })
                                  : t('start.costOwner', {
                                        provider: providerName,
                                        node: node.name,
                                    })}
                        </p>
                        {who === 'agent' && (
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('start.queuedHint', { node: node.name })}
                            </p>
                        )}

                        {error && (
                            <p
                                role="alert"
                                className="text-sm text-danger"
                                data-testid="fleet-session-start-error"
                            >
                                {error.hint ?? t('start.failed')}
                            </p>
                        )}
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => onOpenChange(false)}
                            disabled={pending}
                        >
                            {t('start.cancel')}
                        </Button>
                        <Button
                            type="submit"
                            disabled={!canSubmit}
                            data-testid="fleet-session-start-submit"
                        >
                            {creatingCheckout
                                ? t('start.creatingCheckout', { node: node.name })
                                : pending
                                  ? t('start.starting')
                                  : t('start.submit')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
