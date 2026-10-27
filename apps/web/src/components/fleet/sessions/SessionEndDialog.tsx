'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { FleetSessionView } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { sessionsClient } from './sessions.client';
import type { SessionErrorRead } from './sessions.shared';

/**
 * Sessions on computers (FL-04 P1b, spec FR-18, CONTRACTS §2.2 class
 * `confirm`) — the ONE confirmation for ending a session, opened from the
 * Sessions tab's row menu, the detail page's header and its `E` shortcut
 * alike: "End "build fix" on build-01? The process is stopped. Its screen is
 * kept and you can restart it later." An Agent session adds that its Run ends
 * with it. Ending sends `confirm: true`; nothing else can end a session.
 */
export function SessionEndDialog({
    open,
    onOpenChange,
    session,
    nodeName,
    agentName,
    onEnded,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    session: Pick<FleetSessionView, 'id' | 'title' | 'kind'>;
    nodeName: string;
    agentName?: string | null;
    onEnded?: (view: FleetSessionView) => void;
}) {
    const t = useTranslations('fleet.sessions');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<SessionErrorRead | null>(null);

    const onEnd = async () => {
        setPending(true);
        setError(null);
        const result = await sessionsClient.end(session.id);
        setPending(false);
        if (!result.ok) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
        onEnded?.(result.data);
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                        {t('confirm.endTitle', { title: session.title, node: nodeName })}
                    </DialogTitle>
                    <DialogDescription>{t('confirm.endBody')}</DialogDescription>
                    {session.kind === 'agent' && agentName && (
                        <p
                            className="mt-2 text-sm text-text dark:text-text-dark"
                            data-testid="fleet-session-end-run"
                        >
                            {t('confirm.endRun', { agent: agentName })}
                        </p>
                    )}
                </DialogHeader>
                {error && (
                    <p
                        role="alert"
                        className="text-sm text-danger"
                        data-testid="fleet-session-end-error"
                    >
                        {error.hint
                            ? t('actions.failed', { hint: error.hint })
                            : t('actions.failedGeneric')}
                    </p>
                )}
                <DialogFooter>
                    <Button
                        variant="secondary"
                        onClick={() => onOpenChange(false)}
                        disabled={pending}
                    >
                        {t('confirm.cancel')}
                    </Button>
                    <Button
                        variant="danger"
                        onClick={onEnd}
                        disabled={pending}
                        data-testid="fleet-session-end-confirm"
                    >
                        {pending ? t('confirm.ending') : t('confirm.end')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
