'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Archive } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { archiveAgentAction } from '@/app/actions/agents';

interface ArchiveAgentDialogProps {
    agent: { id: string; name: string };
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Called after the agent is archived — navigate or drop it from the list. */
    onArchived?: () => void;
}

/**
 * Confirmation for `POST /api/agents/:id/archive` — reversible (the
 * archived tab restores it paused), so it is framed as "you can undo
 * this" rather than the terminal warning [[DeleteAgentDialog]] carries.
 *
 * Replaces the previous `window.confirm`, which sat outside the design
 * system, couldn't be styled or translated, and read identically to the
 * irreversible delete.
 */
export function ArchiveAgentDialog({
    agent,
    open,
    onOpenChange,
    onArchived,
}: ArchiveAgentDialogProps) {
    const t = useTranslations('dashboard.agentsPage.archiveDialog');
    // Explicit flag rather than useTransition: the dialog closes on
    // success, so the pending state must survive independently of any
    // parent re-render triggered by the router refresh.
    const [isArchiving, setIsArchiving] = useState(false);

    const confirm = async () => {
        if (isArchiving) return;
        setIsArchiving(true);
        try {
            await archiveAgentAction(agent.id);
            toast.success(t('success', { name: agent.name }));
            onOpenChange(false);
            onArchived?.();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('error'));
        } finally {
            setIsArchiving(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <div className="flex items-start gap-3">
                        <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                            <Archive className="w-4 h-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                            <DialogTitle className="text-sm font-medium text-text dark:text-text-dark">
                                {t('title', { name: agent.name })}
                            </DialogTitle>
                            <DialogDescription>{t('description')}</DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('hint')}</p>

                <DialogFooter>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onOpenChange(false)}
                        disabled={isArchiving}
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        size="sm"
                        onClick={confirm}
                        loading={isArchiving}
                        data-testid="confirm-archive-agent"
                    >
                        {t('confirm')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
