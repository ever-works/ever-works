'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH,
    type FleetSessionActionAvailability,
    type FleetSessionActionTemplate,
} from '@ever-works/contracts';
import { sendSessionActionAction } from '@/app/actions/fleet-session-git';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { sessionGitErrorTitleKey } from './session-git.shared';

/**
 * Session git & actions (FL-06, spec FR-14, U6, U7, §5.3) — the Actions
 * sheet: the rendered prompt, editable, with where its template came from
 * ("Nina's own template"), the reminder that the agent still asks before
 * running anything it was not allowed, the cost note, the amber "this pushes
 * straight to main" for an owner on a protected branch, and the warning that
 * a session waiting on an answer will read the prompt AS the answer. **Send**
 * types it into the session; a send the computer could not confirm says "not
 * delivered" (it may be re-sent from the ledger, never twice silently).
 */
export function SessionActionSheet({
    open,
    onOpenChange,
    sessionId,
    action,
    template,
    label,
    who,
    nodeName,
    branch,
    onSent,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    sessionId: string;
    action: FleetSessionActionAvailability | null;
    template: FleetSessionActionTemplate | null;
    /** The action's label ("Commit and push"). */
    label: string;
    /** The Agent's name, or null for an owner session. */
    who: string | null;
    nodeName: string;
    branch: string | null;
    onSent: (delivered: boolean) => void;
}) {
    const t = useTranslations('fleet.sessionGit.sheet');
    const tErrors = useTranslations('fleet.sessionGit.errorTitles');
    const [prompt, setPrompt] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (open) {
            setPrompt(template?.text ?? '');
            setError(null);
        }
    }, [open, template]);

    if (!action) return null;
    const send = async () => {
        const text = prompt.trim();
        if (!text || pending) return;
        setPending(true);
        setError(null);
        const result = await sendSessionActionAction(sessionId, action.id, text);
        setPending(false);
        if (!result.success) {
            setError(`${tErrors(sessionGitErrorTitleKey(result.code))}${result.hint ? ` — ${result.hint}` : ''}`);
            return;
        }
        const delivered = result.data.delivery === 'delivered';
        if (delivered) toast.success(t('sent', { action: label }));
        else toast.warning(t('notDelivered', { node: nodeName }));
        onSent(delivered);
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent className="max-w-xl">
                <div data-testid="fleet-session-action-sheet" data-action={action.id}>
                    <DialogHeader>
                        <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                            {t('title', { action: label, who: who ?? t('yourSession'), node: nodeName })}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                        {action.warning === 'pushes-protected' ? (
                            <p className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-text dark:text-text-dark" role="status">
                                {t('pushesProtected', { branch: branch ?? 'main' })}
                            </p>
                        ) : null}
                        {action.readAsAnswer ? (
                            <p className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-xs text-text dark:text-text-dark" role="status">
                                {t('readAsAnswer', { who: who ?? t('theAgent') })}
                            </p>
                        ) : null}
                        <textarea
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            maxLength={FLEET_SESSION_ACTION_TEMPLATE_MAX_LENGTH}
                            rows={6}
                            className="w-full rounded-md border border-border dark:border-border-dark bg-transparent px-3 py-2 text-sm"
                            aria-label={t('promptLabel')}
                            data-testid="fleet-session-action-prompt"
                        />
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {template?.source === 'agent' && who ? t('ownTemplate', { who }) : t('defaultTemplate')}
                        </p>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {who ? t('stillAsks', { who }) : t('stillAsksOwner')}
                        </p>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {who ? t('costAgent', { who }) : t('costOwner')}
                        </p>
                        {error ? (
                            <p role="alert" className="text-sm text-danger" data-testid="fleet-session-action-error">
                                {error}
                            </p>
                        ) : null}
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={pending}>
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            onClick={() => void send()}
                            disabled={pending || prompt.trim().length === 0}
                            data-testid="fleet-session-action-send"
                        >
                            {pending ? t('sending') : t('send')}
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
