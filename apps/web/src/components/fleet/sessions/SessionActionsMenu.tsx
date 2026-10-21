'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import {
    FLEET_SESSION_ACTION_IDS,
    type FleetSessionActionAvailability,
    type FleetSessionActionId,
    type FleetSessionActionsResponse,
    type FleetSessionView,
} from '@ever-works/contracts';
import { getSessionActionsAction } from '@/app/actions/fleet-session-git';
import { SHORTCUT_PRIORITY } from '@/lib/keyboard/shortcut-registry';
import { useShortcut } from '@/lib/hooks/use-shortcut';
import { cn } from '@/lib/utils/cn';
import { Button } from '@/components/ui/button';
import { OpenPullRequestDialog } from './OpenPullRequestDialog';
import { SessionActionSheet } from './SessionActionSheet';
import { actionLabelKey, hiddenReasonKey, menuActions, sessionGitErrorTitleKey } from './session-git.shared';

/**
 * Session git & actions (FL-06, spec FR-12 … FR-18, S3 … S9, U1 … U8, §5.2)
 * — **Actions ▾** beside End on the session detail. Only the actions that
 * make sense are listed (the platform's truth table: outside a checkout only
 * the recap, nothing in a shell session, no pull request on the default
 * branch, fix-comments only with unresolved comments, conflicts only when the
 * pull request cannot be merged cleanly); "Update the pull request #912" when
 * one is open. Picking one opens the sheet with its prompt — or, in your own
 * session, the pull-request dialog. Disabled with the reason while the
 * computer is offline or the kill switch is on. Keys: `A` opens it, `1`–`7`
 * pick while it is open, `Esc` closes.
 */
export function SessionActionsMenu({
    session,
    nodeName,
    agentName,
    onSent,
}: {
    session: FleetSessionView;
    nodeName: string;
    agentName: string | null;
    /** Called after a send or a pull request (the ledger re-reads). */
    onSent: () => void;
}) {
    const t = useTranslations('fleet.sessionGit.actions');
    const tErrors = useTranslations('fleet.sessionGit.errorTitles');
    const [open, setOpen] = useState(false);
    const [data, setData] = useState<FleetSessionActionsResponse | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [picked, setPicked] = useState<FleetSessionActionAvailability | null>(null);
    const [prDialog, setPrDialog] = useState(false);
    const [hiddenNote, setHiddenNote] = useState<string | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);

    const load = useCallback(async () => {
        const result = await getSessionActionsAction(session.id);
        if (result.success) {
            setData(result.data);
            setLoadError(null);
        } else {
            setLoadError(`${tErrors(sessionGitErrorTitleKey(result.code))}${result.hint ? ` — ${result.hint}` : ''}`);
        }
    }, [session.id, tErrors]);

    useEffect(() => {
        if (open) void load();
    }, [open, load, session.state, session.git?.gitLine?.at]);

    useEffect(() => {
        if (!open) return;
        const onDown = (event: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
        };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [open]);

    const who = session.kind === 'agent' ? agentName || t('theAgent') : null;
    const shown = data ? menuActions(data.actions) : [];
    const pick = (action: FleetSessionActionAvailability) => {
        setOpen(false);
        setHiddenNote(null);
        if (session.kind === 'owner' && action.id === 'pullRequest' && session.git?.checkoutId) {
            setPrDialog(true);
            return;
        }
        setPicked(action);
    };
    const pickByIndex = (index: number) => {
        const id = FLEET_SESSION_ACTION_IDS[index];
        const action = data?.actions.find((entry) => entry.id === id);
        if (!action) return;
        if (!action.available) {
            setHiddenNote(
                t('hidden', {
                    action: t(`labels.${actionLabelKey(action.id, null)}`),
                    reason: action.reason
                        ? t(`reasons.${hiddenReasonKey(action.reason)}`, { branch: data?.context.branch ?? 'main' })
                        : '',
                }),
            );
            return;
        }
        pick(action);
    };

    useShortcut(
        { id: 'fleet.session.actions', scope: 'fleet-session', priority: SHORTCUT_PRIORITY.screen },
        (event) => event.key.toLowerCase() === 'a' && !event.ctrlKey && !event.metaKey && !event.altKey,
        () => setOpen(true),
    );
    useShortcut(
        { id: 'fleet.session.actions-pick', scope: 'fleet-session', priority: SHORTCUT_PRIORITY.screen, enabled: open },
        (event) => /^[1-7]$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey,
        (event) => pickByIndex(Number((event as KeyboardEvent).key) - 1),
    );
    useShortcut(
        { id: 'fleet.session.actions-close', scope: 'fleet-session', priority: SHORTCUT_PRIORITY.screen, enabled: open },
        (event) => event.key === 'Escape',
        () => setOpen(false),
    );

    const disabled = data?.disabled ?? null;
    const label = (id: FleetSessionActionId, update: { number: number } | undefined) =>
        update ? t('labels.update', { number: update.number }) : t(`labels.${actionLabelKey(id, null)}`);

    return (
        <div className="relative" ref={containerRef}>
            <Button
                size="sm"
                variant="secondary"
                onClick={() => setOpen((value) => !value)}
                aria-haspopup="menu"
                aria-expanded={open}
                data-testid="fleet-session-actions-button"
            >
                {t('button')}
                <ChevronDown className="w-3.5 h-3.5 ml-1" aria-hidden="true" />
            </Button>
            {open ? (
                <div
                    role="menu"
                    className="absolute right-0 z-40 mt-1 w-80 rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark p-1 shadow-lg"
                    data-testid="fleet-session-actions-menu"
                >
                    {loadError ? <p className="px-2 py-1.5 text-xs text-danger">{loadError}</p> : null}
                    {!data && !loadError ? <p className="px-2 py-1.5 text-xs text-text-muted">{t('loading')}</p> : null}
                    {data && session.provider === 'shell' ? (
                        <p className="px-2 py-1.5 text-xs text-text-muted dark:text-text-muted-dark">{t('shellNote')}</p>
                    ) : null}
                    {data && !session.git ? (
                        <p className="px-2 py-1.5 text-xs text-text-muted dark:text-text-muted-dark">{t('notInCheckout')}</p>
                    ) : null}
                    {disabled ? (
                        <p className="px-2 py-1.5 text-xs text-warning" role="status" data-testid="fleet-session-actions-disabled">
                            {tErrors(sessionGitErrorTitleKey(disabled.code))} — {disabled.hint}
                        </p>
                    ) : null}
                    {shown.map((action) => (
                        <button
                            key={action.id}
                            type="button"
                            role="menuitem"
                            disabled={disabled !== null}
                            onClick={() => pick(action)}
                            className={cn(
                                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                                'hover:bg-card-hover dark:hover:bg-card-hover-dark',
                                disabled && 'opacity-50 cursor-not-allowed',
                            )}
                            data-testid={`fleet-session-action-${action.id}`}
                        >
                            <span className="w-4 text-xs tabular-nums text-text-muted">
                                {FLEET_SESSION_ACTION_IDS.indexOf(action.id) + 1}
                            </span>
                            <span className="flex-1">{label(action.id, action.update)}</span>
                            {action.unresolvedComments ? (
                                <span className="text-xs text-text-muted">
                                    {t('unresolved', { count: action.unresolvedComments })}
                                </span>
                            ) : null}
                            {action.warning === 'pushes-protected' ? (
                                <span className="text-xs text-warning">{t('protectedShort')}</span>
                            ) : null}
                        </button>
                    ))}
                    {data && shown.length === 0 && session.provider !== 'shell' ? (
                        <p className="px-2 py-1.5 text-xs text-text-muted dark:text-text-muted-dark">{t('none')}</p>
                    ) : null}
                </div>
            ) : null}
            {hiddenNote ? (
                <p className="absolute right-0 mt-1 w-80 text-xs text-text-muted dark:text-text-muted-dark" role="status">
                    {hiddenNote}
                </p>
            ) : null}
            <SessionActionSheet
                open={picked !== null}
                onOpenChange={(next) => !next && setPicked(null)}
                sessionId={session.id}
                action={picked}
                template={picked && data ? data.templates[picked.id] : null}
                label={picked ? label(picked.id, picked.update) : ''}
                who={who}
                nodeName={nodeName}
                branch={data?.context.branch ?? null}
                onSent={() => onSent()}
            />
            {session.git?.checkoutId ? (
                <OpenPullRequestDialog
                    open={prDialog}
                    onOpenChange={setPrDialog}
                    checkoutId={session.git.checkoutId}
                    sessionId={session.id}
                    onOpened={() => onSent()}
                />
            ) : null}
        </div>
    );
}
