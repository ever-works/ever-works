'use client';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from '@/components/ui/dialog';
import { CheckCircle2, AlertTriangle, Database, FileText, Globe } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { RelatedRepoStatus } from '@/lib/api/directory';
import { useTranslations } from 'next-intl';

interface LinkExistingConfirmProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    repoStatus: {
        data: RelatedRepoStatus & { exists: true; name: string };
        markdown: RelatedRepoStatus;
        website: RelatedRepoStatus;
    };
    onConfirm: (createMissing: boolean) => void;
    isLoading?: boolean;
}

interface RepoStatusRowProps {
    label: string;
    icon: React.ReactNode;
    status: RelatedRepoStatus;
    foundText: string;
    notFoundText: string;
}

function RepoStatusRow({ label, icon, status, foundText, notFoundText }: RepoStatusRowProps) {
    const exists = status.exists;

    return (
        <div
            className={cn(
                'flex items-center justify-between p-3 rounded-lg',
                'bg-surface-secondary dark:bg-surface-secondary-dark',
            )}
        >
            <div className="flex items-center gap-3">
                <div className="text-muted dark:text-text-muted-dark">{icon}</div>
                <div>
                    <p className="font-medium text-foreground dark:text-text-foreground-dark">
                        {label}
                    </p>
                    {status.name && (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {status.name}
                        </p>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-2">
                {exists ? (
                    <>
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                        <span className="text-sm text-green-600 dark:text-green-400">
                            {foundText}
                        </span>
                    </>
                ) : (
                    <>
                        <AlertTriangle className="w-4 h-4 text-amber-500" />
                        <span className="text-sm text-amber-600 dark:text-amber-400">
                            {notFoundText}
                        </span>
                    </>
                )}
            </div>
        </div>
    );
}

export function LinkExistingConfirm({
    open,
    onOpenChange,
    repoStatus,
    onConfirm,
    isLoading,
}: LinkExistingConfirmProps) {
    const t = useTranslations('dashboard.directoryCreation.import.linkConfirm');
    const hasMissingRepos = !repoStatus.markdown.exists || !repoStatus.website.exists;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{t('title')}</DialogTitle>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    <p className="text-sm text-muted dark:text-muted-dark">
                        {hasMissingRepos ? t('descriptionMissing') : t('descriptionReady')}
                    </p>

                    <div className="space-y-2">
                        <RepoStatusRow
                            label={t('dataRepo')}
                            icon={<Database className="w-4 h-4" />}
                            status={repoStatus.data}
                            foundText={t('found')}
                            notFoundText={t('notFound')}
                        />
                        <RepoStatusRow
                            label={t('markdownRepo')}
                            icon={<FileText className="w-4 h-4" />}
                            status={repoStatus.markdown}
                            foundText={t('found')}
                            notFoundText={t('notFound')}
                        />
                        <RepoStatusRow
                            label={t('websiteRepo')}
                            icon={<Globe className="w-4 h-4" />}
                            status={repoStatus.website}
                            foundText={t('found')}
                            notFoundText={t('notFound')}
                        />
                    </div>
                </div>

                <DialogFooter className="flex-col gap-2 sm:flex-row">
                    <Button
                        variant="secondary"
                        onClick={() => onOpenChange(false)}
                        disabled={isLoading}
                    >
                        {t('cancel')}
                    </Button>
                    {hasMissingRepos ? (
                        <>
                            <Button
                                variant="secondary"
                                onClick={() => onConfirm(false)}
                                disabled={isLoading}
                            >
                                {t('continueWithout')}
                            </Button>
                            <Button onClick={() => onConfirm(true)} disabled={isLoading}>
                                {isLoading ? t('creating') : t('createMissing')}
                            </Button>
                        </>
                    ) : (
                        <Button onClick={() => onConfirm(false)} disabled={isLoading}>
                            {isLoading ? t('linking') : t('linkRepos')}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
