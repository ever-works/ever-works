'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

interface RemoveDomainDialogProps {
    /** Domain being removed; `null` keeps the dialog closed. */
    domain: string | null;
    /** True while the removal server action is in flight. */
    isRemoving: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

/**
 * EW-611 — confirmation for `DELETE /api/deploy/works/:id/domains/:domain`.
 *
 * Removing a custom domain is not a local UI toggle: it detaches the host at
 * the deploy provider (a Vercel project domain, or a patch to the Work's k8s
 * Ingress) and deletes the `WorkCustomDomain` row, so live traffic on that
 * hostname stops once DNS/ingress propagates. That earns a real dialog rather
 * than an immediate mutation on the trash icon.
 *
 * Deliberately NOT `window.confirm`: it is unstyled, untranslatable, and
 * blocks the event loop — the repo's other destructive flows
 * (`DeleteAgentDialog`, `ArchiveAgentDialog`) use this same Dialog shape.
 *
 * Provider-agnostic by design: the copy never names Vercel or Kubernetes, so
 * one dialog serves every deploy provider (EW-611 AC3).
 */
export function RemoveDomainDialog({
    domain,
    isRemoving,
    onCancel,
    onConfirm,
}: RemoveDomainDialogProps) {
    const t = useTranslations('dashboard.workDetail.deploy.domains.removeDialog');

    // Escape / backdrop clicks route through `onOpenChange` too, so the dialog
    // could otherwise vanish mid-request and hide the outcome toast.
    const requestClose = (next: boolean) => {
        if (!next && isRemoving) return;
        if (!next) onCancel();
    };

    return (
        <Dialog open={domain !== null} onOpenChange={requestClose}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <div className="flex items-start gap-3">
                        <div className="shrink-0 w-9 h-9 rounded-lg bg-danger/10 border border-danger/20 flex items-center justify-center">
                            <AlertTriangle className="w-4 h-4 text-danger" />
                        </div>
                        <div className="min-w-0">
                            <DialogTitle className="text-sm font-medium text-text dark:text-text-dark">
                                {t('title', { domain: domain ?? '' })}
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
                        onClick={onCancel}
                        disabled={isRemoving}
                        data-testid="cancel-remove-domain"
                    >
                        {t('cancel')}
                    </Button>
                    <Button
                        variant="danger"
                        size="sm"
                        onClick={onConfirm}
                        loading={isRemoving}
                        data-testid="confirm-remove-domain"
                    >
                        {t('confirm')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
