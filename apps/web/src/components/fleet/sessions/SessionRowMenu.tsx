'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { MoreHorizontal } from 'lucide-react';
import { isFleetSessionLive, type FleetSessionView } from '@ever-works/contracts';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SessionEndDialog } from './SessionEndDialog';
import { SessionRenameDialog } from './SessionRenameDialog';
import { sessionsClient } from './sessions.client';

/**
 * Sessions on computers (FL-04 P1b, spec §5.1) — a session row's ⋯ menu:
 * Open · Rename · Copy link · End… (live) or Restart (ended). End opens the
 * same confirmation the detail page uses ({@link SessionEndDialog}); Restart
 * starts a new session with the ended one's kind, CLI, folder and title and
 * opens it.
 */
export function SessionRowMenu({
    session,
    nodeName,
    agentName,
    onChanged,
}: {
    session: FleetSessionView;
    nodeName: string;
    agentName?: string | null;
    onChanged?: (view: FleetSessionView) => void;
}) {
    const t = useTranslations('fleet.sessions');
    const router = useRouter();
    const [ending, setEnding] = useState(false);
    const [renaming, setRenaming] = useState(false);
    const live = isFleetSessionLive(session.state);

    const copyLink = async () => {
        try {
            // Sessions are the person's own (not an Organization's): the bare
            // route resolves to the reader's locale and personal scope.
            const href = `${window.location.origin}${ROUTES.DASHBOARD_FLEET_SESSION(session.id)}`;
            await navigator.clipboard.writeText(href);
            toast.success(t('actions.linkCopied'));
        } catch {
            toast.error(t('actions.failedGeneric'));
        }
    };

    const restart = async () => {
        const result = await sessionsClient.restart(session.id);
        if (!result.ok) {
            toast.error(result.error.hint ? t('actions.failed', { hint: result.error.hint }) : t('actions.failedGeneric'));
            return;
        }
        toast.success(t('actions.restarted'));
        onChanged?.(result.data);
        router.push(ROUTES.DASHBOARD_FLEET_SESSION(result.data.id));
    };

    return (
        <>
            <DropdownMenu>
                <DropdownMenuTrigger
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-card-hover dark:hover:bg-card-hover-dark"
                    aria-label={t('actions.menu')}
                    data-testid="fleet-session-row-menu"
                >
                    <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => router.push(ROUTES.DASHBOARD_FLEET_SESSION(session.id))}>
                        {t('actions.open')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setRenaming(true)}>{t('actions.rename')}</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void copyLink()}>{t('actions.copyLink')}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {live ? (
                        <DropdownMenuItem onClick={() => setEnding(true)} className="text-danger">
                            {t('actions.end')}
                        </DropdownMenuItem>
                    ) : (
                        <DropdownMenuItem onClick={() => void restart()}>{t('actions.restart')}</DropdownMenuItem>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            <SessionEndDialog
                open={ending}
                onOpenChange={setEnding}
                session={session}
                nodeName={nodeName}
                agentName={agentName}
                onEnded={(view) => {
                    toast.success(t('actions.ended'));
                    onChanged?.(view);
                }}
            />
            <SessionRenameDialog
                open={renaming}
                onOpenChange={setRenaming}
                session={session}
                onRenamed={(view) => {
                    toast.success(t('actions.renamed'));
                    onChanged?.(view);
                }}
            />
        </>
    );
}
