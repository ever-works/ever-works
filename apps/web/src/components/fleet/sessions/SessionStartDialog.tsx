'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import {
    FLEET_SESSION_CWD_MAX_LENGTH,
    FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH,
    FLEET_SESSION_TITLE_MAX_LENGTH,
    isFleetSessionAgentProvider,
    type FleetNodeView,
    type FleetSessionStartableProvider,
    type FleetSessionView,
} from '@ever-works/contracts';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { sessionsClient } from './sessions.client';
import {
    canStartOwnerSession,
    defaultProvider,
    errorField,
    providerInstalled,
    providerKey,
    SESSION_DIALOG_PROVIDERS,
    type SessionErrorRead,
} from './sessions.shared';

/**
 * Sessions on computers (FL-04 P1b, spec §5.2, FR-12 … FR-17) — "New
 * session" on one computer: who → what → where → (first message) → start.
 *
 *  - **Who**: You (an owner session — runs as you, in your login; needs
 *    `--manage`). The Agent row is shown and says it arrives with the next
 *    release (P2), so the dialog's shape does not change when it does.
 *  - **What**: Claude Code, Codex, a shell — a CLI the computer does not
 *    advertise is greyed "not installed on build-01".
 *  - **Where**: a folder on the computer, with the folders of its last ten
 *    sessions as one-click chips. "In a new worktree" is greyed until
 *    Checkouts (FL-14) ships.
 *  - **First message** (agent CLIs): typed into the CLI when it starts.
 *  - **The cost sentence**: your own login, no Ever Works tokens.
 *
 * A refusal keeps every field and marks the one it names (`invalid` with
 * `details.field`); success opens the session page.
 */
export function SessionStartDialog({
    open,
    onOpenChange,
    node,
    onStarted,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    node: FleetNodeView;
    onStarted?: (view: FleetSessionView) => void;
}) {
    const t = useTranslations('fleet.sessions');
    const router = useRouter();
    const [provider, setProvider] = useState<FleetSessionStartableProvider>(() => defaultProvider(node));
    const [cwd, setCwd] = useState('');
    const [title, setTitle] = useState('');
    const [firstMessage, setFirstMessage] = useState('');
    const [recent, setRecent] = useState<string[]>([]);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<SessionErrorRead | null>(null);
    const ownerAllowed = canStartOwnerSession(node);

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

    const field = errorField(error);
    const agentCli = isFleetSessionAgentProvider(provider);
    const providerName = t(`providers.${providerKey(provider)}`);
    const canSubmit =
        ownerAllowed &&
        !pending &&
        cwd.trim().length > 0 &&
        cwd.length <= FLEET_SESSION_CWD_MAX_LENGTH &&
        providerInstalled(node, provider);

    const onSubmit = async (event: FormEvent) => {
        event.preventDefault();
        if (!canSubmit) return;
        setPending(true);
        setError(null);
        const result = await sessionsClient.start(node.id, {
            kind: 'owner',
            provider,
            cwd: cwd.trim(),
            ...(title.trim() ? { title: title.trim() } : {}),
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
                            <div className="grid gap-2 sm:grid-cols-2">
                                <div className={radio(true, !ownerAllowed)} data-testid="fleet-session-start-who-owner">
                                    {t('start.you')}
                                </div>
                                <div
                                    className={radio(false, true)}
                                    aria-disabled="true"
                                    data-testid="fleet-session-start-who-agent"
                                >
                                    <span>
                                        {t('start.agent')}
                                        <span className="block text-xs text-text-muted dark:text-text-muted-dark">
                                            {t('start.agentLater')}
                                        </span>
                                    </span>
                                </div>
                            </div>
                            {!ownerAllowed && (
                                <p className="text-xs text-warning" role="status">
                                    {t('start.noConsent', { node: node.name })}
                                </p>
                            )}
                        </fieldset>

                        <fieldset className="space-y-2">
                            <legend className="text-xs font-medium text-text-muted dark:text-text-muted-dark">
                                {t('start.what')}
                            </legend>
                            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup">
                                {SESSION_DIALOG_PROVIDERS.map((option) => {
                                    const installed = providerInstalled(node, option);
                                    return (
                                        <button
                                            key={option}
                                            type="button"
                                            role="radio"
                                            aria-checked={provider === option}
                                            disabled={!installed}
                                            onClick={() => setProvider(option)}
                                            className={radio(provider === option, !installed)}
                                            data-testid={`fleet-session-start-provider-${option}`}
                                        >
                                            <span>
                                                {t(`providers.${providerKey(option)}`)}
                                                {!installed && (
                                                    <span className="block text-xs text-text-muted dark:text-text-muted-dark">
                                                        {t('start.notInstalled', { node: node.name })}
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
                                        field === 'cwd' ? 'border-danger' : 'border-border dark:border-border-dark',
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
                            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                                {t('start.inFolder')} · {t('start.worktreeLater')}
                            </p>
                        </fieldset>

                        <label className="block space-y-1 text-sm">
                            <span className="text-text-muted dark:text-text-muted-dark">{t('start.sessionTitle')}</span>
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
                                <span className="text-text-muted dark:text-text-muted-dark">{t('start.firstMessage')}</span>
                                <textarea
                                    value={firstMessage}
                                    onChange={(event) => setFirstMessage(event.target.value)}
                                    maxLength={FLEET_SESSION_FIRST_MESSAGE_MAX_LENGTH}
                                    rows={3}
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
                                    {t('start.firstMessageHint', { provider: providerName })}
                                </span>
                            </label>
                        )}

                        <p className="text-xs text-text-muted dark:text-text-muted-dark" data-testid="fleet-session-start-cost">
                            {provider === 'shell'
                                ? t('start.costShell', { node: node.name })
                                : t('start.costOwner', { provider: providerName, node: node.name })}
                        </p>

                        {error && (
                            <p role="alert" className="text-sm text-danger" data-testid="fleet-session-start-error">
                                {error.hint ?? t('start.failed')}
                            </p>
                        )}
                    </div>

                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
                            {t('start.cancel')}
                        </Button>
                        <Button type="submit" disabled={!canSubmit} data-testid="fleet-session-start-submit">
                            {pending ? t('start.starting') : t('start.submit')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
