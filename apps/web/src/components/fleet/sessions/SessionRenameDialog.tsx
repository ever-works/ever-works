'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { FLEET_SESSION_TITLE_MAX_LENGTH, type FleetSessionView } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { sessionsClient } from './sessions.client';
import type { SessionErrorRead } from './sessions.shared';

/**
 * Sessions on computers (FL-04 P1b, spec FR-19) — rename a session (1–200
 * characters). The platform's title wins and the computer is told, so the
 * title survives a node restart.
 */
export function SessionRenameDialog({
    open,
    onOpenChange,
    session,
    onRenamed,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    session: Pick<FleetSessionView, 'id' | 'title'>;
    onRenamed?: (view: FleetSessionView) => void;
}) {
    const t = useTranslations('fleet.sessions');
    const [title, setTitle] = useState(session.title);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<SessionErrorRead | null>(null);

    useEffect(() => {
        if (open) {
            setTitle(session.title);
            setError(null);
        }
    }, [open, session.title]);

    const trimmed = title.trim();
    const valid = trimmed.length > 0 && trimmed.length <= FLEET_SESSION_TITLE_MAX_LENGTH;

    const onSubmit = async (event: FormEvent) => {
        event.preventDefault();
        if (!valid || pending) return;
        setPending(true);
        const result = await sessionsClient.rename(session.id, trimmed);
        setPending(false);
        if (!result.ok) {
            setError(result.error);
            return;
        }
        onOpenChange(false);
        onRenamed?.(result.data);
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent>
                <form onSubmit={onSubmit}>
                    <DialogHeader>
                        <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                            {t('actions.renameTitle')}
                        </DialogTitle>
                    </DialogHeader>
                    <label className="block space-y-1 text-sm">
                        <span className="text-text-muted dark:text-text-muted-dark">
                            {t('actions.renameLabel')}
                        </span>
                        <input
                            autoFocus
                            value={title}
                            maxLength={FLEET_SESSION_TITLE_MAX_LENGTH}
                            onChange={(event) => setTitle(event.target.value)}
                            className="w-full rounded-md border border-border dark:border-border-dark bg-transparent px-3 py-2 text-sm"
                            data-testid="fleet-session-rename-input"
                        />
                    </label>
                    {error && (
                        <p role="alert" className="mt-2 text-sm text-danger">
                            {error.hint
                                ? t('actions.failed', { hint: error.hint })
                                : t('actions.failedGeneric')}
                        </p>
                    )}
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => onOpenChange(false)}
                            disabled={pending}
                        >
                            {t('actions.cancel')}
                        </Button>
                        <Button
                            type="submit"
                            disabled={!valid || pending}
                            data-testid="fleet-session-rename-save"
                        >
                            {t('actions.save')}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
