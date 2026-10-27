'use client';

import { useTranslations } from 'next-intl';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * APW-03 T31 (lane aw-blueprints) — the confirmation before a Blueprint run, in its two
 * variants (plan §5.2:622):
 *
 *  - **apply** — a Blueprint for an App Work that has none;
 *  - **upgrade** — a newer version of the one it follows, with the **Breaking** warning
 *    on a `MAJOR` bump.
 *
 * Both say the same three things before anything happens: a pull request is opened on
 * the App's repository and only `.works/works.yml` changes; a value the member changed is
 * kept, never overwritten, and every conflict is listed; nothing takes effect until the
 * member merges it.
 */
export interface AppBlueprintUpgradeDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    variant: 'apply' | 'upgrade';
    blueprintId: string;
    version: string | null;
    fromVersion: string | null;
    breaking: boolean;
    busy: boolean;
    onConfirm: () => void;
}

export function AppBlueprintUpgradeDialog({
    open,
    onOpenChange,
    variant,
    blueprintId,
    version,
    fromVersion,
    breaking,
    busy,
    onConfirm,
}: AppBlueprintUpgradeDialogProps) {
    const t = useTranslations('dashboard.workDetail.settings.appSpec.blueprint.dialog');

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogClose onClose={() => onOpenChange(false)} />
                <div
                    className="space-y-4"
                    data-testid="app-blueprint-dialog"
                    data-variant={variant}
                >
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {variant === 'apply'
                                ? t('applyTitle', { id: blueprintId })
                                : t('upgradeTitle', { id: blueprintId, version: version ?? '' })}
                        </DialogTitle>
                        <DialogDescription className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {variant === 'apply'
                                ? t('applyBody')
                                : t('upgradeBody', {
                                      from: fromVersion ?? '—',
                                      version: version ?? '',
                                  })}
                        </DialogDescription>
                    </DialogHeader>
                    <ul className="list-disc space-y-1 pl-5 text-sm text-text dark:text-text-dark">
                        <li>{t('pointPullRequest')}</li>
                        <li>{t('pointKept')}</li>
                        <li>{t('pointMerge')}</li>
                    </ul>
                    {breaking && (
                        <p
                            data-testid="app-blueprint-dialog-breaking"
                            className="rounded-md bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
                        >
                            {t('breaking')}
                        </p>
                    )}
                    <DialogFooter className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => onOpenChange(false)}
                            disabled={busy}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            onClick={onConfirm}
                            disabled={busy}
                            loading={busy}
                            data-testid="app-blueprint-dialog-confirm"
                        >
                            {variant === 'apply' ? t('confirmApply') : t('confirmUpgrade')}
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
