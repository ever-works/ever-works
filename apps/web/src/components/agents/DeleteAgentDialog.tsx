'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
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
import { deleteAgentHardAction } from '@/app/actions/agents';

interface DeleteAgentDialogProps {
    agent: { id: string; name: string };
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Called after the row is gone — navigate or drop it from the list. */
    onDeleted?: () => void;
}

/**
 * Confirmation for `DELETE /api/agents/:id?hard=true` — the permanent,
 * cascading delete (budgets + memberships + the row itself), as opposed
 * to Archive, which only flips `status` and is reversible in the data
 * even though the UI treats it as terminal.
 *
 * Deliberately NOT `window.confirm`: this is the one irreversible
 * action on an Agent, so it gets a dialog that spells out what goes
 * with it and keeps the destructive button visually distinct.
 */
export function DeleteAgentDialog({
    agent,
    open,
    onOpenChange,
    onDeleted,
}: DeleteAgentDialogProps) {
    const t = useTranslations('dashboard.agentsPage.deleteDialog');
    // Explicit flag rather than useTransition: the dialog closes on
    // success, so the pending state must survive independently of any
    // parent re-render triggered by the router refresh.
    const [isDeleting, setIsDeleting] = useState(false);

    const confirm = async () => {
        if (isDeleting) return;
        setIsDeleting(true);
        try {
            await deleteAgentHardAction(agent.id);
            toast.success(t('success', { name: agent.name }));
            onOpenChange(false);
            onDeleted?.();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('error'));
        } finally {
            setIsDeleting(false);
        }
    };

    // Escape and outside clicks reach `onOpenChange` too, so the dialog
    // could otherwise vanish mid-request and hide the outcome toast.
    const requestClose = (next: boolean) => {
        if (!next && isDeleting) return;
        onOpenChange(next);
    };

    return (
        <Dialog open={open} onOpenChange={requestClose}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <div className="flex items-start gap-3">
                        <div className="shrink-0 w-9 h-9 rounded-lg bg-danger/10 border border-danger/20 flex items-center justify-center">
                            <AlertTriangle className="w-4 h-4 text-danger" />
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
                        disabled={isDeleting}
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        variant="danger"
                        size="sm"
                        onClick={confirm}
                        loading={isDeleting}
                        data-testid="confirm-delete-agent"
                    >
                        {t('confirm')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
